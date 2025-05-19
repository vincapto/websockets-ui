import { parseMaybeJson, makeJsonMsg, sendToAll } from "./util.js";

export function handleReg(cmd, ws, players, sendUpdateRoom, sendUpdateWinners, nextPlayerIndexRef) {
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
		index = nextPlayerIndexRef.value++;
		players.set(name, { password, wins: 0, index, ws });
	}

	const response = makeJsonMsg("reg", { name, index, error, errorText });
	ws.send(response);
	console.log("Sent:", JSON.parse(response));
	sendUpdateRoom();
	sendUpdateWinners();
}

export function handleCreateRoom(ws, players, rooms, nextRoomId, sendUpdateRoom) {
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

	const roomId = nextRoomId();
	rooms.set(roomId, {
		roomId,
		roomUsers: [{ name: playerName, index: playerIndex }],
	});
	sendUpdateRoom();
	console.log("Room created:", { roomId, playerName, playerIndex });
	console.log("All rooms:", Array.from(rooms.entries()));
}

export function handleAddUserToRoom(cmd, ws, players, rooms, games, nextGameId, sendUpdateRoom, makeJsonMsg) {
	const data = parseMaybeJson(cmd.data);
	const { indexRoom } = data || {};

	let playerName, playerIndex;

	console.log("Trying to join room:", indexRoom);

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


	const roomId = Number(indexRoom);
	const room = rooms.get(roomId);

	console.log("Player joining room:", { playerName, playerIndex });
	console.log("Found room:", room);

	if (room && room.roomUsers.length === 1) {
		room.roomUsers.push({ name: playerName, index: playerIndex });
		sendUpdateRoom();

		const idGame = nextGameId();
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
}

export function handleAddShips(cmd, players, games, sendTurn, makeJsonMsg) {
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
}

export function handleAttack(cmd, players, games, checkShot, sendTurn, sendUpdateWinners, makeJsonMsg) {
	const data = parseMaybeJson(cmd.data);
	let x, y;

	if (typeof data.x === 'number' && typeof data.y === 'number') {
		x = data.x;
		y = data.y;
	} else if (data.position && typeof data.position.x === 'number' && typeof data.position.y === 'number') {
		x = data.position.x;
		y = data.position.y;
	}
	const { gameId, indexPlayer } = data || {};
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
		for (let i = 0; i < 10; i++) {
			for (let j = 0; j < 10; j++) allCells.push([i, j]);
		}

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

	const { status, win } = checkShot(game, defender.index, shotX, shotY);

	const attackMsg = makeJsonMsg("attack", {
		position: { x: shotX, y: shotY },
		currentPlayer: attacker.index,
		status,
	});

	game.players.forEach((u) => {
		const wsTarget = players.get(u.name).ws;
		if (wsTarget && wsTarget.readyState === 1)
			wsTarget.send(attackMsg);
	});

	console.log("Sent:", JSON.parse(attackMsg));

	if (win) {
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
		if (status === "miss") {
			game.turn = defender.index;
		}
		sendTurn(game);
	}
}
