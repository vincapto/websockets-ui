import { httpServer } from "./src/http_server/index.js";
import { WebSocketServer } from "ws";
import { parseMaybeJson, sendToAll, makeJsonMsg } from "./util.js";

const HTTP_PORT = 8181;

console.log(`Start static http server on the ${HTTP_PORT} port!`);
httpServer.listen(HTTP_PORT);

const players = new Map();
const rooms = new Map();
const games = new Map();
let winners = [];

let nextRoomId = 1;
let nextGameId = 1;
let nextPlayerIndex = 1;

const WS_PORT = 3000;
const wss = new WebSocketServer({ port: WS_PORT });

console.log(`WebSocket server started on ws://localhost:${WS_PORT}`);

wss.on("connection", (ws) => {
	ws.on("message", (message) => {
		let cmd;
		try {
			cmd = JSON.parse(message);
		} catch (e) {
			ws.send(
				JSON.stringify({
					type: "error",
					data: { error: true, errorText: "Invalid JSON" },
					id: 0,
				})
			);
			return;
		}
		console.log("Received:", cmd);
		if (cmd.type === "reg") {
			const data = parseMaybeJson(cmd.data);
			const { name, password } = data;
			let error = false;
			let errorText = "";
			let index;
			if (!name || !password) {
				error = true;
				errorText = "Name and password required";
			} else if (players.has(name)) {
				if (players.get(name).password !== password) {
					error = true;
					errorText = "Incorrect password";
				} else {
					index = players.get(name).index;
					players.get(name).ws = ws;
				}
			} else {
				index = nextPlayerIndex++;
				players.set(name, { password, wins: 0, index, ws });
			}
			const response = makeJsonMsg("reg", { name, index, error, errorText });
			ws.send(response);
			console.log("Sent:", JSON.parse(response));
			sendUpdateRoom();
			sendUpdateWinners();
		} else if (cmd.type === "create_room") {
			let playerName, playerIndex;
			for (const [name, info] of players.entries()) {
				if (info.ws === ws) {
					playerName = name;
					playerIndex = info.index;
					break;
				}
			}

			if (!playerName) {
				playerName = Array.from(players.keys()).pop();
				playerIndex = players.get(playerName).index;
				players.get(playerName).ws = ws;
			}

			const roomId = nextRoomId++;
			rooms.set(roomId, {
				roomId,
				roomUsers: [{ name: playerName, index: playerIndex }],
			});

			sendUpdateRoom();

			console.log("Room created:", { roomId, playerName, playerIndex });
			console.log("All rooms:", Array.from(rooms.entries()));
		} else if (cmd.type === "add_user_to_room") {
			const data = parseMaybeJson(cmd.data);
			const { indexRoom } = data || {};
			console.log("Trying to join room:", indexRoom);

			let playerName, playerIndex;
			for (const [name, info] of players.entries()) {
				if (info.ws === ws) {
					playerName = name;
					playerIndex = info.index;
					break;
				}
			}
			if (!playerName) {
				playerName = Array.from(players.keys()).pop();
				playerIndex = players.get(playerName).index;
				players.get(playerName).ws = ws;
			}
			console.log("Player joining room:", { playerName, playerIndex });

			const roomId = Number(indexRoom);
			const room = rooms.get(roomId);

			console.log("Found room:", room);

			if (room && room.roomUsers.length === 1) {
				room.roomUsers.push({ name: playerName, index: playerIndex });

				sendUpdateRoom();

				const idGame = nextGameId++;
				const [p1, p2] = room.roomUsers;
				games.set(idGame, {
					idGame,
					players: [p1, p2],
					ships: {},
					turn: null,
					finished: false,
				});

				room.roomUsers.forEach((u) => {
					const wsTarget = players.get(u.name).ws;
					if (wsTarget && wsTarget.readyState === 1) {
						const resp = makeJsonMsg("create_game", { idGame, idPlayer: u.index });
						wsTarget.send(resp);
						console.log("Sent create_game to player:", u.name);
					} else {
						console.log("Warning: Could not send create_game to player:", u.name);
					}
				});
			} else {
				console.log("Failed to join room - Room not found or already full");
			}
		} else if (cmd.type === "add_ships") {
			const data = parseMaybeJson(cmd.data);
			const { gameId, ships, indexPlayer } = data || {};
			const game = games.get(Number(gameId));
			if (!game) return;
			game.ships[indexPlayer] = ships;
			if (Object.keys(game.ships).length === 2) {
				const [p1, p2] = game.players;
				const currentPlayerIndex = Math.random() < 0.5 ? p1.index : p2.index;
				game.turn = currentPlayerIndex;
				game.players.forEach((u) => {
					const wsTarget = players.get(u.name).ws;
					if (wsTarget && wsTarget.readyState === 1) {
						const resp = makeJsonMsg("start_game", {
							ships: game.ships[u.index],
							currentPlayerIndex,
						});
						wsTarget.send(resp);
						console.log("Sent:", resp);
					}
				});
				sendTurn(game);
			}
		} else if (cmd.type === "attack" || cmd.type === "randomAttack") {
			const data = parseMaybeJson(cmd.data);
			const { gameId, x, y, indexPlayer } = data || {};
			const game = games.get(Number(gameId));
			if (!game || game.finished) return;

			const attacker = game.players.find((p) => p.index === indexPlayer);
			const defender = game.players.find((p) => p.index !== indexPlayer);

			if (!attacker || !defender) return;
			if (game.turn !== attacker.index) return;
			let shotX = x,
				shotY = y;
			if (cmd.type === "randomAttack") {
				const allCells = [];
				for (let i = 0; i < 10; i++)
					for (let j = 0; j < 10; j++) allCells.push([i, j]);
				game.shots = game.shots || {};
				const shotCells = Object.keys(game.shots).map((k) =>
					k.split(",").map(Number)
				);
				const available = allCells.filter(
					([i, j]) => !shotCells.some(([x, y]) => x === i && y === j)
				);
				if (available.length) {
					const [rx, ry] =
						available[Math.floor(Math.random() * available.length)];
					shotX = rx;
					shotY = ry;
				}
			}
			game.shots = game.shots || {};
			const key = shotX + "," + shotY;
			if (game.shots[key]) return;
			game.shots[key] = { by: attacker.index };
			const result = checkShot(game, defender.index, shotX, shotY);
			const attackMsg = makeJsonMsg("attack", {
				position: { x: shotX, y: shotY },
				currentPlayer: attacker.index,
				status: result.status,
			});
			game.players.forEach((u) => {
				const wsTarget = players.get(u.name).ws;
				if (wsTarget && wsTarget.readyState === 1)
					wsTarget.send(attackMsg);
			});
			console.log("Sent:", JSON.parse(attackMsg));
			if (result.win) {
				game.finished = true;
				const finishMsg = makeJsonMsg("finish", { winPlayer: attacker.index });
				game.players.forEach((u) => {
					const wsTarget = players.get(u.name).ws;
					if (wsTarget && wsTarget.readyState === 1)
						wsTarget.send(finishMsg);
				});
				players.get(attacker.name).wins++;
				sendUpdateWinners();
				console.log("Sent:", JSON.parse(finishMsg));
			} else {
				if (result.status === "miss") {
					game.turn = defender.index;
				}
				sendTurn(game);
			}
		}
	});
	ws.on("close", () => {});
});

function sendUpdateRoom() {
	const roomsList = Array.from(rooms.values()).filter(
		(r) => r.roomUsers && r.roomUsers.length === 1
	);
	const data = roomsList.map((room) => ({
		roomId: room.roomId,
		roomUsers: room.roomUsers.map((u) => ({
			name: u.name,
			index: u.index,
		})),
	}));
	const msg = makeJsonMsg("update_room", data);
	sendToAll(wss, msg);
	console.log("Sent:", { type: "update_room", data });
}

function sendUpdateWinners() {
	winners = Array.from(players.entries()).map(([name, { wins }]) => ({
		name,
		wins,
	}));
	const msg = makeJsonMsg("update_winners", winners);
	sendToAll(wss, msg);
	console.log("Sent:", { type: "update_winners", data: winners });
}

function sendTurn(game) {
	const msg = makeJsonMsg("turn", { currentPlayer: game.turn });
	game.players.forEach((u) => {
		const wsTarget = players.get(u.name).ws;
		if (wsTarget && wsTarget.readyState === 1) wsTarget.send(msg);
	});
	console.log("Sent:", { type: "turn", data: { currentPlayer: game.turn } });
}

function checkShot(game, defenderIndex, x, y) {
	const ships = game.ships[defenderIndex] || [];
	let status = "miss";
	let win = false;
	for (const ship of ships) {
		const cells = getShipCells(ship);
		for (const cell of cells) {
			if (cell.x === x && cell.y === y) {
				status = "shot";
				ship.hits = ship.hits || [];
				ship.hits.push({ x, y });
				if (ship.hits.length === ship.length) {
					status = "killed";
				}
				break;
			}
		}
	}
	if (ships.every((s) => s.hits && s.hits.length === s.length)) win = true;
	return { status, win };
}

function getShipCells(ship) {
	const cells = [];
	for (let i = 0; i < ship.length; i++) {
		cells.push({
			x: ship.position.x + (ship.direction ? i : 0),
			y: ship.position.y + (ship.direction ? 0 : i),
		});
	}
	return cells;
}

process.on("SIGINT", () => {
	wss.close(() => {
		console.log("WebSocket server closed.");
		process.exit(0);
	});
});
