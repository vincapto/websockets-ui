export function parseMaybeJson(data) {
	if (typeof data === "string") {
		try {
			return JSON.parse(data);
		} catch (e) {
			return {};
		}
	}
	return data || {};
}

export function sendToAll(wss, msg) {
	wss.clients.forEach((client) => {
		if (client.readyState === 1) client.send(msg);
	});
}

export function makeJsonMsg(type, data, id = 0) {
	return JSON.stringify({ type, data: JSON.stringify(data), id });
}
