import { httpServer } from "./src/http_server/index.js";
import { WebSocketServer } from "ws";
import { parseMaybeJson, sendToAll, makeJsonMsg } from "./util.js";
import { handleReg, handleCreateRoom, handleAddUserToRoom, handleAddShips, handleAttack } from "./wsHandlers.js";

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
const nextPlayerIndexRef = { value: nextPlayerIndex };

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
			handleReg(cmd, ws, players, sendUpdateRoom, sendUpdateWinners, nextPlayerIndexRef);
		} else if (cmd.type === "create_room") {
			handleCreateRoom(ws, players, rooms, () => nextRoomId++, sendUpdateRoom);
		} else if (cmd.type === "add_user_to_room") {
			handleAddUserToRoom(cmd, ws, players, rooms, games, () => nextGameId++, sendUpdateRoom, makeJsonMsg);
		} else if (cmd.type === "add_ships") {
			handleAddShips(cmd, players, games, sendTurn, makeJsonMsg);
		} else if (cmd.type === "attack" || cmd.type === "randomAttack") {
			handleAttack(cmd, players, games, checkShot, sendTurn, sendUpdateWinners, makeJsonMsg);
		}
	});
	ws.on("close", () => {});
});

function sendUpdateRoom() {
	const roomsList = Array.from(rooms.values());
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
				ship.hits = ship.hits || [];
				const alreadyHit = ship.hits.some(h => h.x === x && h.y === y);

				if (!alreadyHit) {
					ship.hits.push({ x, y });
				}

				if (ship.hits.length === ship.length) {
					status = "killed";
				} else {
					status = "shot";
				}

				break;
			}
		}
		if (status === "shot" || status === "killed") break;
	}

	if (ships.every((s) => s.hits && s.hits.length === s.length)) win = true;

	return { status, win };
}

function getShipCells(ship) {
	const cells = [];
	for (let i = 0; i < ship.length; i++) {
		cells.push({
			x: ship.position.x + (ship.direction ? 0 : i), 
			y: ship.position.y + (ship.direction ? i : 0),
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
