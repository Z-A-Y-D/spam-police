//Import dependencies
import {
	AutojoinRoomsMixin,
	MatrixClient,
	SimpleFsStorageProvider,
} from "matrix-bot-sdk";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

//Import modules
import { blacklist } from "./modules/blacklist.js";
import { redaction } from "./modules/redaction.js";
import { database } from "./modules/db.js";
import { message } from "./modules/message.js";
import { Reaction } from "./modules/reaction.js";
import { BanlistReader } from "./modules/banlistReader.js";

//Parse YAML configuration file
const loginFile = readFileSync("./db/login.yaml", "utf8");
const loginParsed = parse(loginFile);
const homeserver = loginParsed["homeserver-url"];
const accessToken = loginParsed["login-token"];
const logRoom = loginParsed["log-room"];
const commandRoom = loginParsed["command-room"];
const authorizedUsers = loginParsed["authorized-users"];
const name = loginParsed.name;

//the bot sync something idk bro it was here in the example so i dont touch it ;-;
const storage = new SimpleFsStorageProvider("bot.json");

//login to client
const client = new MatrixClient(homeserver, accessToken, storage);

//currently testing without accepting invites
//AutojoinRoomsMixin.setupOnClient(client);

//map to put the handlers for each event type in (i guess this is fine here)
const eventhandlers = new Map();

const config = new database(); // Database for the config
const nogoList = new blacklist(); // Blacklist object
eventhandlers.set(
	"m.room.message",
	new message(logRoom, commandRoom, config, authorizedUsers),
); // Event handler for m.room.message
eventhandlers.set("m.policy.rule.user", new BanlistReader(client));
eventhandlers.set("m.reaction", new Reaction(logRoom));
eventhandlers.set("m.room.redaction", new redaction(eventhandlers)); // Event handler for m.room.redaction

//preallocate variables so they have a global scope
let mxid;
let server;

const reactionQueue = new Map();

const filter = {
	//dont expect any presence from m.org, but in the case presence shows up its irrelevant to this bot
	presence: { senders: [] },
	room: {
		//ephemeral events are never used in this bot, are mostly inconsequentail and irrelevant
		ephemeral: { senders: [] },
		//we fetch state manually later, hopefully with better load balancing
		state: {
			senders: [],
			not_types: [
				"im.vector.modular.widgets",
				"im.ponies.room_emotes",
				"m.room.pinned_events",
			],
			lazy_load_members: true,
		},
		//we will manually fetch events anyways, this is just limiting how much backfill bot gets as to not
		//respond to events far out of view
		timeline: {
			limit: 20,
		},
	},
};

//Start Client
client.start(filter).then(async (filter) => {
	console.log("Client started!");

	//to remotely monitor how often the bot restarts, to spot issues
	client.sendText(logRoom, "Started.").catch((e) => {
		console.log("Error sending basic test message to log room.");
		process.exit(1);
	});

	//get mxid
	mxid = await client.getUserId();
	server = mxid.split(":")[1];

	//fetch rooms the bot is in
	const rooms = await client.getJoinedRooms();

	//fetch avatar url so we dont overrite it
	let avatar_url;

	try {
		const userProfile = await client.getUserProfile(mxid);
		avatar_url = userProfile.avatar_url;
	} catch (error) {
		console.error("Error fetching user profile:", error);
		// Handle the error as needed (e.g., provide a default avatar URL)
		avatar_url = "";
	}

	//slowly loop through rooms to avoid ratelimit
	const i = setInterval(async () => {
		//if theres no rooms left to work through, stop the loop
		if (rooms.length < 1) {
			clearInterval(i);

			return;
		}

		//work through the next room on the list
		const currentRoom = rooms.pop();

		//debug
		console.log(`Setting displayname for room ${currentRoom}`);

		//fetch the room list of members with their profile data
		const mwp = await client
			.getJoinedRoomMembersWithProfiles(currentRoom)
			.catch(() => {
				console.log(`error ${currentRoom}`);
			});

		//variable to store the current display name of the bot
		let cdn = "";

		//if was able to fetch member profiles (sometimes fails for certain rooms) then fetch the current display name
		if (mwp) cdn = mwp[mxid].display_name;

		//fetch prefix for that room
		let prefix = config.getConfig(currentRoom, "prefix");

		//default prefix if none set
		if (!prefix) prefix = "+";

		//establish desired display name based on the prefix
		const ddn = `${prefix} | ${name}`;

		//if the current display name isnt the desired one
		if (cdn !== ddn) {
			//send member state with the new displayname
			client
				.sendStateEvent(currentRoom, "m.room.member", mxid, {
					avatar_url: avatar_url,
					displayname: ddn,
					membership: "join",
				})
				.then(console.log(`done ${currentRoom}`))
				.catch((e) => console.error);
		}

		// 3 second delay to avoid ratelimit
	}, 3000);

	// displayname = (await client.getUserProfile(mxid))["displayname"]
});

//when the client recieves an event
client.on("room.event", async (roomId, event) => {
	//ignore events sent by self, unless its a banlist policy update
	if (event.sender === mxid && !(event.type === "m.policy.rule.user")) {
		return;
	}

	//check banlists
	bancheck(roomId, event);

	//fetch the handler for that event type
	const handler = eventhandlers.get(event.type);

	//if there is no handler for that event, exit.
	if (!handler) return;

	//fetch the room list of members with their profile data
	const mwp = await client
		.getJoinedRoomMembersWithProfiles(roomId)
		.catch(() => {
			console.log(`error ${roomId}`);
		});

	//variable to store the current display name of the bot
	let cdn = "";

	//if was able to fetch member profiles (sometimes fails for certain rooms) then fetch the current display name
	if (mwp) cdn = mwp[mxid].display_name;
	else {
		//fetch prefix for that room
		let prefix = config.getConfig(roomId, "prefix");

		//default prefix if none set
		if (!prefix) prefix = "+";

		//establish desired display name based on the prefix
		cdn = `${prefix} | ${name}`;
	}

	handler.run({
		client: client,
		roomId: roomId,
		event: event,
		mxid: mxid,
		server: server,
		displayname: cdn,
		blacklist: nogoList,
		reactionQueue: reactionQueue,
		banListReader: eventhandlers.get("m.policy.rule.user"),
		config: config,
	});
});

client.on("room.leave", (roomId) => {
	nogoList.add(roomId, "kicked");
});

async function bancheck(roomId, event) {
	//if the bot cant ban users in the room, theres no reason to waste resources and check if it should ban the user
	if (!(await client.userHasPowerLevelForAction(mxid, roomId, "ban"))) {
		return;
	}

	//fetch banlists for room
	let roomBanlists = config.getConfig(roomId, "banlists");

	//if there is no config, create a temporary one with just the room id
	if (!roomBanlists) {
		roomBanlists = [roomId];
	}

	//if there is a config, set the room up to check its own banlist
	else {
		roomBanlists.push(roomId);
	}

	//variable to store reason
	let reason;

	//look through all banlists
	for (let i = 0; i < roomBanlists.length; i++) {
		const rm = roomBanlists[i];

		//find recommendation
		const recomend = await eventhandlers
			.get("m.policy.rule.user")
			.match(rm, event.sender)[0];

		//if that room doesn't recommend a ban, go ahead and exit out
		if (!recomend) {
			continue;
		}

		//fetch the set alias of the room
		let mainRoomAlias = await client.getPublishedAlias(rm);

		//if there is no alias of the room
		if (!mainRoomAlias) {
			//dig through the state, find room name, and use that in place of the main room alias
			mainRoomAlias = (await client.getRoomState(roomId)).find(
				(state) => state.type === "m.room.name",
			).content.name;
		}

		//format together a reason
		reason = `${recomend.content.reason} (${mainRoomAlias})`;
	}

	//if there is a reason to be had, then we can ban
	if (reason) {
		client.banUser(event.sender, roomId, reason).catch(() => {});
	}
}

// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⣀⣀⣀⣀⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣤⠶⠚⠛⠉⠉⠉⠀⠀⠉⠉⠙⠓⠦⣤⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⣾⣿⠴⠶⠦⢤⣤⣀⡀⠀⠀⠀⠀⠀⠀⠀⠈⠙⠳⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⡿⠛⠛⠒⢦⡀⠀⠀⠉⠙⠳⢶⣤⣄⣀⣀⣀⣀⣀⣤⠜⢷⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⡏⠀⠀⠀⠀⠀⠹⣄⠀⠀⢀⠔⠋⠉⠉⠛⢍⠉⠉⣽⠃⠀⢀⣻⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣠⡤⢾⡇⠀⠀⣸⣧⠤⢤⣏⠉⠙⡏⠀⠀⢀⣀⠀⠈⣧⠴⣷⠶⠾⣿⡟⣿⡀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣴⠟⠁⠀⠀⠹⣄⡼⠋⠀⠀⠀⠈⠁⠀⣧⠀⠀⠈⠁⠀⢠⡇⠀⠀⠀⠀⢻⠷⠛⣷⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⡟⠁⠀⠀⠀⠀⠀⠀⢳⡄⠀⠀⠀⠀⠀⠀⠈⠳⢄⣀⣀⠴⠋⠀⠀⠀⠀⠀⠀⠀⠀⠸⣇⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⢠⡿⠀⠀⠀⠀⠀⠀⢀⡤⠀⠉⠓⠦⠤⠤⠖⠀⠀⠀⠀⠀⠀⢀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢻⡄⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⣼⠁⠀⠀⠀⠀⠀⠀⣨⠧⣄⣀⡀⠀⠀⠀⠀⠀⢀⣀⣠⡤⠶⠛⡧⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⣧⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⣿⠀⠀⠀⠀⠀⠀⠀⠻⣤⣄⡈⠉⠉⠉⠉⠉⠉⠉⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢿⡀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢻⡁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⡇⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣸⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⡇⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⣷⠀⠀⠀⠀⠀⠀⠀⠀⣴⠋⠉⠀⠀⠀⠀⠀⠀⠀⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⡇⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⣿⠀⠀⠀⠀⠀⠀⠀⢸⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⣧⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⡇⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⣿⠀⠀⠀⠀⠀⠀⠀⠀⢷⣄⠀⠀⣀⣄⠀⠀⠀⠀⢀⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⡇⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⢹⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠉⠉⠉⠉⠳⠦⠤⠴⠛⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⡇⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⢸⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣼⣧⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⢠⣿⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣤⠞⠁⢸⣇⡀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⣿⠀⢻⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⡴⠛⠁⠀⣰⠏⠉⠙⠳⢦⣄
// ⠀⠀⠀⠀⢀⣤⠞⠻⣆⠀⠙⢷⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⡤⠞⠉⠀⠀⣠⡾⠁⠀⠀⠀⠀⠀⠈
// ⠀⠀⣀⡴⠟⠁⠀⠀⠙⢧⡀⠀⠉⠻⢦⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⣤⠴⠖⠛⠉⠀⠀⢀⣤⠞⠉⠀⠀⠀⠀⠀⠀⠀⠀
// ⣤⠞⠋⠀⠀⠀⠀⠀⠀⠀⠻⣦⡀⠀⠀⠈⠛⢶⣄⠀⠀⠀⠀⠀⣀⣤⠴⠖⠛⠉⠁⠀⠀⠀⠀⣀⡤⠖⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠻⣦⡀⢀⣤⠶⢿⣧⠀⣠⣶⣯⣭⣀⠀⠀⠀⠀⠀⣀⣤⠴⠛⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⣷⠏⠀⢠⢬⣿⡿⠋⠁⠀⠀⠈⠙⣦⡴⠖⠋⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠀⠀⢙⣿⡟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠒⠂⠀⠀⠀⠀⠀⠀⡀⣀⣔

// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣠⣤⠶⠶⠶⠶⣶⣦⣤⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣴⣾⣟⣋⣀⢀⣀⣤⣤⡾⠿⠿⠿⣿⣷⢦⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣴⣿⣿⣿⡟⠛⢻⡿⣿⣿⣦⡀⠀⢠⡾⡿⠯⠽⢦⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣾⣿⡇⣿⣿⣷⢴⡏⠉⣧⠀⠀⢹⠒⢻⣀⣘⡇⠀⢸⠷⠶⠤⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣾⡿⠉⠁⠀⠀⠀⠘⣧⠀⠀⠀⢀⡼⠀⠉⠁⠀⠉⢱⡏⠀⠀⠰⢄⠑⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣼⢹⠇⠀⠀⠀⠀⠀⠀⣈⡙⠒⠒⠉⠀⢠⣄⣀⣀⣀⡼⠃⠀⠀⠀⠈⢣⠈⣆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⢧⡾⠀⠀⠀⠀⠀⠀⠀⠉⠓⠦⢄⣀⣀⠀⠈⠉⢉⣁⣐⡶⠀⠀⠀⠀⠀⠁⢸⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣸⣬⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠉⠉⠉⠉⠀⠀⠉⢲⡄⠀⠀⠀⠀⢰⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡇⢹⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⡼⠋⠀⠀⠀⠀⠀⢈⢧⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡇⣸⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠶⣏⡀⠀⠀⠀⠀⠀⠀⠀⢸⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣷⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢷⡀⠀⠀⠀⠀⠐⣸⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣿⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⣀⠀⠀⠀⠀⢨⡇⠀⠀⠀⠀⠀⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⡾⣗⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⢯⣀⣀⣀⡴⠻⣄⣂⣀⡴⠟⠀⠀⠀⠀⠀⠀⢿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⡴⣯⠀⠙⣿⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣸⢳⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⡤⠚⠉⣀⣀⣈⣳⡀⠈⠳⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣰⠇⠀⡟⠦⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⡴⠊⠁⣠⠖⠋⠁⠀⠀⠉⠻⣆⠀⠈⠙⢦⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⡴⠁⢀⡞⠀⠀⠀⠉⠲⢄⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⣠⠞⠁⢀⡴⠋⠀⠀⠀⠀⠀⠀⠀⠀⠈⠳⢄⡀⠀⠉⠳⣤⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⠏⠀⢠⡞⠀⠀⠀⠀⠀⠀⠀⠙⠶⡄⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⡠⠊⠁⠀⡴⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠙⠦⣀⠀⠀⠉⠓⠦⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⡴⠋⠁⠀⡴⠋⠀⠀⢰⡀⠀⠀⠀⠀⠀⠀⠈⢳⠲⣄⠀
// ⠀⠀⠀⣠⡾⠥⠤⠤⠬⠤⣄⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠓⢤⣀⠀⠀⠀⠉⠓⠒⠤⢤⣀⡀⠀⣠⣞⣉⠀⠀⢠⠞⠁⠀⠀⠀⠘⡇⠀⠀⠀⠀⠀⠀⠀⢸⡆⢸⢄
// ⠀⡴⢋⣁⣠⠤⠄⠒⠠⠀⠀⠀⠉⠳⢤⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠙⠲⢤⣀⠀⠀⢀⡴⠚⠛⢷⡏⠀⠈⢷⠔⠁⠀⠀⠀⠀⠀⠀⣿⣆⠀⠀⠀⠀⠀⠀⣸⠁⡸⠀
// ⢀⡿⠋⠉⢀⣀⣀⡤⠤⢤⣀⣀⠀⠀⠀⠙⢦⡀⠀⠀⠀⢀⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠙⠲⢾⠀⠀⢠⣷⣿⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⢿⣆⠀⠀⠀⠀⣰⠇⠐⠁⢀
// ⡞⢀⡴⠚⠉⣠⠞⠁⠀⠀⠀⠈⠙⢦⡀⠀⠀⢳⡀⠀⣰⠟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠀⢳⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢿⡃⢀⣤⠞⠁⠀⠀⣠⠏
// ⠙⣿⠀⠀⣼⠉⠀⠀⠀⠀⠀⠀⠀⠀⢩⢦⠀⣤⣧⠜⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢷⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢻⣍⣥⢔⣠⡴⠛⠁⢠
// ⠀⢹⠀⢠⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠎⢧⢸⡏⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣤⣤⣷⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠹⣟⠉⠁⠀⠀⢰⣜
// ⠀⠘⣇⢸⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⣞⡾⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠿⣿⢿⠟⠒⠂⠀⠀⠀⠀⠀⠀⠀⠀⠀⢻⡧⠀⠀⠀⣌⠇
// ⠀⠀⠹⣼⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠐⢳⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢳⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢻⡀⠀⠀⡜⠀
// ⠀⠀⠀⢻⣳⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠟⡆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢳⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢇⠀⣰⠃⠀
// ⠀⠀⠀⠀⠹⣷⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⢹⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⢤⣧⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⠀⢻⡀⠀
// ⠀⠀⠀⠀⠀⣸⣷⡀⠀⠀⠀⠀⠀⡀⠀⠀⠀⠀⡟⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠉⠹⡆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⡇⠀⡇⠀
// ⠀⠀⠀⢠⣴⡿⠞⠿⣄⠀⠀⢀⣼⠁⠀⠀⠀⠀⠀⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠸⣧⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⠇⣰⢣⡀
// ⠀⠀⠀⠸⣼⣦⣠⣶⠿⢦⣤⣾⣷⡀⠀⠀⠀⠀⡅⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣸⠀⠇⢰⠃
// ⠀⠀⠀⠀⠀⠉⢿⡇⠀⢰⡏⠀⣻⡟⠛⢦⠀⢀⢿⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⣤⣼⠇⠀⠀⠀⠀⠀⠀⢠⡆⢀⣴⣃⢀⣠⠏⠀
// ⠀⠀⠀⠀⠀⠀⠈⣿⡦⣼⡇⠀⢻⣇⠀⢸⠀⢨⠏⠀⠀⢀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢉⡟⠀⠀⠀⠀⠀⠀⣠⣿⣴⡏⠉⠉⠁⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⢸⣿⣿⣷⣦⣼⣿⣦⣬⣴⣿⣶⣤⣤⣌⣳⣄⠀⠀⠀⠀⠘⢦⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⠞⠀⠀⠀⣀⣤⣴⣿⣿⣿⡿⡇⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⢿⡇⠀⠙⠙⠿⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣶⣤⡤⣤⣭⣿⣭⣔⣀⣀⣀⣀⣀⣀⣀⣤⡤⠴⠒⠋⠉⠙⢿⣿⣿⣿⣿⠉⣿⢿⣿⣷⠁⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠈⢿⡂⠀⠀⠀⠀⠈⠉⠙⠛⠿⠿⢿⣿⣿⣿⣿⣿⣿⡇⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡁⠀⠀⠀⠀⣀⣜⣼⣿⠿⠟⠻⠀⠈⣸⣿⠏⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢻⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠉⠛⠻⠇⠀⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠟⠿⠶⠤⠤⠶⠞⠋⠁⠀⠀⠀⠀⠀⣴⣿⠋⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠹⣦⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⣾⡿⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⢷⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⡿⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣶⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⡧⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣠⠤⠞⠁⠀⠀⠀⠀⠀⠀⠀⠀⢸⢹⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣼⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢰⡏⠉⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣸⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣼⠇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⠏⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⡿⡆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣸⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢿⡆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣷⣧⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢿⢻⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣀⣀⣀⠀⠀⢸⡇⠀⠀⠀⠀⠀⠀⣠⣴⣶⣿⣿⣿⣿⣿⣿⣾⣇⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢹⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣠⣴⣾⣿⣿⣿⣿⣿⣿⣶⣾⣧⡀⠀⠀⣠⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣇⡀⠀⠀⠀⠀⠀⣀⣤⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡄⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣼⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡞⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⡇⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⢸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠇⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠙⠻⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟⠙⠛⠛⠛⠛⠛⠛⠛⠛⠛⠛⠛⠛⠉⠉⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠉⠉⠛⠛⠛⠿⠿⠿⠿⠿⠿⠿⠿⠿⠿⠛⠛⠋⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀

// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡀⠄⠒⠒⠀⠀⠒⠂⠠⢀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡠⠂⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠀⢄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠑⢄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡠⠀⠀⣐⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣠⠀⠡⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡐⠀⠀⠈⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠁⠀⠀⠐⠄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⢀⠄⠂⠠⢀⡀⠀⠀⠀⠀⠔⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠨⡄⠀⠀⠀⠀⢀⠠⠐⠒⠐⠄
// ⢠⠁⠀⠀⠀⠀⠀⠈⠉⠉⠉⠀⠀⠀⠀⠀⣀⣤⣶⣿⣿⣿⣿⣿⣿⣶⣦⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⡤⡀⠁⠉⠀⠀⠀⠀⠀⠈
// ⢸⠀⠀⠀⠀⠀⠀⠀⠀⠐⠀⠀⠀⠀⣠⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣆⠀⠀⠀⠀⠀⠀⠀⠀⠀⢱⠰⠀⠀⠀⠀⠀⠀⠀⢨
// ⠘⠄⠤⠀⠀⠀⠀⠀⠀⡆⠀⠀⢀⣼⣿⣿⠿⠿⠛⠻⠛⠛⠛⠙⠛⠛⠋⠩⠝⣿⣷⡄⠀⠀⠀⠀⠀⠀⠀⢘⣿⡶⣶⠲⢶⣴⣦⡄⠁
// ⠀⠀⠇⠀⠀⠀⠠⠔⢈⠁⠁⠀⣾⣿⡏⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢃⡹⣿⣿⣷⠀⠀⠀⠀⠀⠀⠀⠀⣿⣝⡾⣑⢎⡷⣏⡇⠀
// ⠀⠀⠏⠛⠓⠻⠷⠿⢿⠀⠀⠀⣿⣿⠇⠀⠀⠀⠀⣀⣠⣄⣤⣄⣀⣀⣀⠀⠸⣽⣿⣿⠀⠀⠀⠀⠀⠀⠀⠀⣽⡾⣝⣳⢎⡿⡥⠂⠀
// ⠀⠀⢰⠀⠀⠀⠀⠀⢘⠀⠀⠀⢿⣿⢰⣤⣴⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠀⠀⠀⠀⠀⠀⠀⠀⣿⡽⣯⡽⢾⣹⡓⠀⠀
// ⠀⠀⢸⠀⠀⠀⠀⠀⠨⠀⡀⢠⡘⣿⠸⣿⣿⡟⣋⢿⣿⡿⠙⣿⣿⡿⣽⢻⣿⡿⢽⣷⡇⠀⠀⠀⠀⠀⠀⢠⣿⣟⣷⡻⣝⣧⢹⠀⠀
// ⠀⠀⠘⡀⠀⠀⠀⠀⠀⡄⠙⠀⣿⣿⠀⠈⠛⠂⠡⠾⠟⠁⠀⡨⠟⠓⣖⣋⡁⣤⣿⢿⡇⠀⠀⠀⠀⠀⠀⢸⣿⣞⣷⡻⣽⡺⡥⠀⠀
// ⠀⠀⠀⡄⠀⠀⠀⠀⠀⡇⠀⠀⢹⣯⡦⣤⣦⣤⡄⣃⠀⠀⠀⢴⣛⣶⢏⣾⣿⣿⣿⣻⠁⠀⠀⠀⠀⠀⠀⣸⣿⢾⣳⣟⡷⡽⡁⠀⠀
// ⠀⠀⠀⠇⠀⠀⠀⠀⠀⢡⢸⣡⡍⢳⣿⣳⣭⡷⡤⠝⣤⣁⣀⣺⣿⢻⢾⣭⣿⣿⡿⠃⠀⠀⠀⠰⣭⣱⢀⣿⣿⣻⡽⣾⣝⣷⠁⠀⠀
// ⠀⠀⠀⢰⠀⠀⢀⢀⠀⢈⡆⠁⠀⠀⠸⣷⣻⢿⣿⣶⣼⣿⣿⣿⣯⣿⣿⣿⣿⣿⠇⠀⠀⠀⠀⠀⠉⠀⣼⣿⡷⣿⣽⣳⢯⠸⠀⠀⠀
// ⠀⠀⠀⠈⡄⠀⠀⢢⠳⡠⢼⠀⠀⠀⠀⢿⣶⣂⢿⣿⣏⢙⠈⠙⢻⣿⣿⣿⣿⡟⠀⠀⠀⠀⠀⠀⠀⢰⣿⣿⣽⡷⣯⣟⠯⡆⠀⠀⠀
// ⠀⠀⠀⠀⠰⠀⠀⠀⡑⢝⢦⣇⠀⠀⠀⠘⣿⣿⣦⡹⢿⣶⣶⣶⢿⣿⣿⣿⣿⠁⠀⠀⠀⠀⠀⠀⢠⣿⣿⣟⣾⣿⣻⣞⢷⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠇⠀⠶⡈⡎⣷⡾⣷⡀⠀⠀⣿⣿⣿⣿⣆⠈⣀⣈⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⣰⣿⣿⣿⣿⡿⣷⣿⡎⡆⠀⠀⠀⠀
// ⠀⠀⠀⠀⢀⠈⠮⠵⠵⠎⠵⠛⠛⠛⠛⠻⢻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠷⠶⠶⠶⠾⠿⠿⠿⠿⠿⠿⠽⣿⣟⢗⠜⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⣅⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠁⠀⠀⠀⠀⠀⠀⢀⠀⣀⣀⣀⣀⡈⠎⠁⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠈⠀⠀⠉⠉⠉⠀⠀⠀⠀⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠂⠐⠀⠈⠀⠉⠉⠉⠉⠀⠀⠀⠀⠐⢰⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡀⢄⡰⢠⢒⡰⢂⡖⣐⠺⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⢀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⠠⢄⢢⡱⣘⢦⡜⣣⢮⡵⣫⡼⣧⢹⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⢱⡰⢶⡖⣦⢤⣤⣤⣤⣤⣄⣀⣀⣀⣀⣀⣀⣀⣄⣤⣔⣦⣳⢦⣟⣮⣷⣻⣽⣞⣿⡽⣯⣿⣟⣿⠫⠁⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⢇⠢⡙⢤⠛⣼⢳⣻⢮⣝⡯⣽⣹⢮⡽⣭⣛⢮⣗⡻⣞⡽⣯⣻⠷⣯⢷⣻⢾⣽⣛⣷⣻⣞⢧⠁⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠘⡵⣹⢦⣛⢦⣏⣷⣻⢮⡽⣶⣛⣮⢗⡷⣫⣟⡼⣝⣧⠿⣵⢯⡿⣭⢿⣭⣟⡾⣽⡞⣷⢏⠆⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠸⣟⣯⣟⡿⣞⡷⣯⢿⡽⣞⣳⣭⢿⣹⣗⡾⣝⡾⣞⣻⡽⣾⡽⢯⣷⣛⡾⣽⣳⢿⢙⠊⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠈⠪⠿⣽⣯⢿⡽⣯⢿⣽⣳⢯⣟⡷⡾⣝⣻⡼⣯⢷⣻⣗⣿⣻⢾⣽⣻⠷⡫⠂⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠑⠩⢟⢿⣽⣟⣾⣽⣟⣾⣽⡿⣽⣷⣻⣽⣯⣷⣻⣾⡽⡛⠎⠃⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠀⠀⠀⠉⠉⠉⠙⠛⠛⡙⢩⠩⣅⠫⢖⡭⣿⢺⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠸⠀⠀⠀⠀⠀⠀⠀⠀⠀⠐⠀⠣⡐⢍⠎⡼⣻⡟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠄⠱⡈⢎⡱⣝⣏⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠠⢑⠢⣑⢮⢿⣠⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠸⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠡⠌⡒⡡⢞⣯⢯⠱⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡐⢢⠁⢧⡙⣮⣟⣾⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢂⠍⢦⡙⣮⢿⡈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡌⡘⢦⣙⣾⣋⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀

// _______________7777777777777777777777___________________
// __________77777_____________________77777_______________
// _______7777_____________________________777_____________
// _____7u___________________________________777___________
// ___717_______________________________________777________
// ___5___________________________________________71_______
// __7n_____________________________________________17_____
// _71_______________________________7_______________77____
// _u________________________________7________________u____
// _u________________________________7______7_________7u___
// u__________________________71_____7_____7___________5___
// u__________________________o867___7_____7____73o7___7u__
// 5__________________________71d03________7__768d5_____71_
// n__________________n5777774n__u005_77_____508u________u_
// 1__________________6u7u34u1nnnn4d86777771u8046u777711147
// u___7777777________4174u7566u77_7d807__70806qd64447__7b5
// n7__7777777771nnnnub47447nu3445477d81__48073n146457___du
// _5_________________16777______7u7__b4uq8q7717777117__707
// _71_________________ou36964664447__67_7n3u51777_7777_435
// __n7_________7_____7____7_777777nnnu_____37771n4443u467n
// ___7n_______7n54_77_____777____77_________1____7__7__77n
// _____u______74dd7bn_____77____n7___________71___7_7____3
// _____7u______ud9u51______7__77_777__________5___777___nq
// ______u______74dd7_77____7_77__71____7_____unn__77n7_1n_
// ______u7______1d5_ub7___7_7u31__7u571577_717_44_15n43q1_
// ______u7_______1o1q37___5u47454d088888880d3u774_1d3uu77_
// ______u7______7__73u4u43n076888888888888888884776q647___
// ______5_______7___77u0u77775888888888888888801_77db7____
// _____17_______7_____u8454u4n88888888888888807_771577____
// _____5______________1u_7ub67ud8888888888d6137740d7______
// ____17____________________ndu774d444q57773u3dd375_______
// ___n7______________________50b76b75uu97757q9udb7________

// _________________77777777777777777777777777______________________
// ___________777777__________________________7777__________________
// _______7777____________________________________7777______________
// _____757______________77___777777777777777777______777___________
// ____6_________________________________________________717________
// ___57_______________________777777_______________________57______
// __4________________________________77777777777777_________57_____
// _57________________________________________________________37____
// 73___________________77777777777777_________________777777774____
// 6__________________77_________________7____________7_______711___
// 9______________________________________77_______17___________73__
// 3______________________777777777777777________________________4__
// 5__79777777111115111114077777777____77141_________15111111111144_
// 6__107________________16_74__48889577___891777153105714693____330
// _3___7________________16__77754433171___87_______597750946____678
// _74___________________1977_____________70________33_____7______68
// __75___________7__________771111111111177______477511115515111559
// ____57____777594________________________________17___________17_6
// _____75_______451_________________________________71__________765
// _______4_____7705___________________47____________75________7763_
// _______37_____77957__________________777__77___7711______77_747__
// _______37_____7746317_________777_____77737717777___7____77767___
// _______37_______79661_________5____50643191197351895_3___797_____
// _______6________777_907_______71__588888888888888889_7_7797______
// ______47________7__731901_________708888888888888897__7144_______
// _____71_______________7661477______798888888888805__74951________
// ____15__________________7_45_1_______10888880657__7695___________
// ___47________7777__________7401_67_____7717______4967____________

//          _nnnn_
//         dGGGGMMb
//        @p~qp~~qMb
//        M|@||@) M|
//        @,----.JM|
//       JS^\__/  qKL
//      dZP        qKRb
//     dZP          qKKb
//    fZP            SMMb
//    HZM            MMMM
//    FqM            MMMM
//  __| ".        |\dS"qML
//  |    `.       | `' \Zq
// _)      \.___.,|     .'
// \____   )MMMMMP|   .'
//      `-'       `--' hjm

// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⣠⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣄⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⣤⣶⣾⣿⣿⡿⠟⠛⠛⠛⠛⠛⠻⠿⣿⣿⣿⣿⣿⣷⣶⣤⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣤⣶⣿⣿⣿⣿⠟⠋⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠛⢿⣿⣿⣿⣿⣿⣿⣶⣤⣄⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⣠⣶⣿⣿⣿⣿⣿⠟⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠹⣿⣿⣿⣿⣿⣿⣿⣿⣷⡄⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⣼⡿⣿⣿⣿⣿⣿⠇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣹⣿⣿⣿⣿⣿⣿⣿⣿⣿⣆⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⣿⣿⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢹⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⢻⣿⡟⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢹⣿⣿⣿⣿⣿⣿⣿⣿⡟⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠘⢿⣼⡟⢻⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⠳⠆⠀⠀⠀⠹⣿⣿⣿⣿⣿⣿⡟⠁⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⢈⣻⣷⣾⣿⡇⠀⠀⠀⢀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣀⣀⠀⠀⠀⢻⣿⣿⣿⡿⢋⡀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⣿⠉⠙⢿⣿⡇⠀⠀⠀⠈⢻⣿⣷⣶⣄⣠⠀⠀⠀⣀⣠⣾⣿⣿⡯⠉⠁⠀⠀⠀⢻⣿⣿⡿⠛⢿⡆⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⣟⠀⠘⢾⡿⠀⠀⠀⢀⣠⣤⣶⣿⣿⣿⠟⠀⠀⣿⣿⣿⣿⣿⣷⣦⣄⡀⠀⠀⠀⢸⣿⣯⠀⣶⡆⣿⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⣿⠈⠀⣼⠃⠀⠀⠘⠋⠁⣈⣹⣿⣿⠏⠀⠀⠀⣿⣿⣏⠀⣈⣁⣈⡝⠻⠿⡆⠀⠰⣿⣏⠈⣿⢷⡟⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⣿⠀⠰⡇⠀⠀⠀⠀⠀⠀⠁⠀⠀⠀⠀⠀⠀⠀⢸⣽⣿⣆⠀⠀⠀⠀⠀⠀⠁⠀⢸⣿⣿⡆⣏⣿⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⣿⠀⠀⢱⡀⠀⠀⠀⠀⠀⠀⠀⠀⣀⠀⠀⠀⠀⠀⠀⢿⣿⡄⠀⠀⠀⠀⠀⠀⠀⢸⣿⡟⣿⣿⡇⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠙⣄⠀⠀⣸⡄⠀⠀⠀⠀⠀⢀⡞⠁⣤⣤⣀⣠⣤⣀⣄⣸⣿⣦⡀⠀⠀⠀⠀⠀⢸⣿⣄⠟⣼⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠹⠷⠶⠻⡇⠀⠀⠀⠀⠀⠟⠀⠀⠀⠀⠉⠙⠿⠿⣿⠉⢀⡿⣷⡀⢸⣇⢰⠀⠸⣿⣡⡾⠃⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⡇⠀⠀⠀⠀⠀⣀⠀⠀⠀⠀⠐⠛⠀⠀⠁⠀⠀⢰⡟⢷⢸⣿⢀⠀⠀⣿⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠸⡇⠀⠀⠀⠀⣼⡿⠓⠶⠒⠛⠛⠉⠙⠛⠻⠻⠿⣿⡇⠀⢸⡟⠀⠀⣠⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢘⡇⠒⠀⠀⠀⠈⠀⠀⠀⠀⠀⣶⠶⠶⠶⠶⠀⢀⣿⠁⢠⡾⠁⠀⣰⣿⠉⢇⠀⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢈⡷⠶⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠁⠀⠿⠃⢀⣴⡟⢹⡄⠘⣧⠀⠀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣠⠞⢁⡆⠀⠐⢢⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠀⠒⠀⠀⣠⣴⣿⡟⣰⡿⣡⡄⠈⢣⡀⠀⠀⠀⠀⠀⠀
// ⠀⠀⠀⠀⠀⣀⣠⡤⠖⠒⠋⠁⠀⠘⣷⠀⠀⠀⠙⠦⣄⣀⣀⣀⣀⣀⣤⣶⣿⣦⣤⣴⣶⣿⡿⢋⣼⠟⢁⣿⠁⣠⣤⡉⠀⠀⠀⠀⠀⠀
// ⣠⠤⠔⠒⠚⠉⠁⠀⠀⠀⠀⠀⠀⠀⢹⡆⠀⠀⠀⠀⠉⠻⣿⣿⣿⣯⣥⣤⣤⣶⣿⣿⡿⠋⣠⡿⠁⠀⠀⠁⠲⢈⣿⣿⣷⣤⣄⠀⠀⠀
// ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⢦⡀⠤⡄⠀⠀⠀⠀⠉⡻⢿⣧⣿⣿⡟⢋⣤⡾⠋⠀⠀⠀⠀⠘⠛⢺⣿⣿⣿⣿⣿⣷⣤⣤
// ⡀⠀⣀⣀⣀⣀⣀⣀⣀⠀⠀⠀⠀⠀⠀⠀⠀⠙⢦⣈⣳⣦⣤⣤⣿⣿⣿⠟⢋⣡⣶⣿⠋⢀⠀⠀⠀⡀⠀⠀⢀⡌⠘⣿⣿⣿⣿⣿⣿⣿
