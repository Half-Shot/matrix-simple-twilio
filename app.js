#!/usr/bin/env node
const { accountSid, authToken, personalPhoneNumber, twilioPhoneNumber } = require('./config');
const { Bridge, MatrixRoom, RemoteRoom } = require('matrix-appservice-bridge');
const client = require('twilio')(accountSid, authToken);
const express = require('express');
const fs = require('fs').promises;

// Create a Twilio conversation instance.
async function getTwilioConversation() {
    let convo;
    try {
        const convoSid = await fs.readFile('./convo-sid', 'utf-8');
        return client.conversations.conversations(convoSid).fetch();
    } catch (ex) {
        console.warn(`SID file does not exist, creating`);
    }

    convo = await client.conversations.conversations.create({friendlyName: 'CommCon demo'})

    // Create a conversation
    console.log(`Created new convo ${convo.sid}`);
    await convo.participants().create({
        'messagingBinding.address': personalPhoneNumber,
        'messagingBinding.proxyAddress': twilioPhoneNumber,
    });

    // Create a webhook
    await convo.webhooks().create({
        configuration: {
            url: webhookUrl,
            method: 'GET',
            filters: ['onMessageAdded']
        },
        target: 'webhook',
    });    
    await fs.writeFile('./convo-sid', convo.sid);
    return convo;
}

async function main() {
    const convo = await getTwilioConversation();

    async function onMatrixEvent(request, context) {
        const eventData = request.getData();
        console.log("New matrix event:", eventData.type ,eventData.event_id);

        // If it's a membership invite, we should create a new room.
        if (eventData.type === "m.room.member" && eventData.content.membership === "invite") {
            // @twilio_122244444:beefy
            const [phoneNumber] = eventData.state_key.substr('@twilio_'.length).split(':');
            const intent = bridge.getIntent(eventData.state_key);

            // Set a nice name
            await intent.setDisplayName(`+${phoneNumber} (Twilio)`);

            // Join the room
            await intent.join(eventData.room_id);

            // Map the room to the phone number
            await bridge.getRoomStore().linkRooms(new MatrixRoom(eventData.room_id), new RemoteRoom('+' + phoneNumber));
        }

        // If it's just a message, send the message along
        if (eventData.type === "m.room.message" && context.rooms.remote && !context.ctx.sender.startsWith('@twilio_')) {
            // Send the message to the one conversation
            convo.messages().create({body: eventData.content.body});
        }
    }

    // Setup the Matrix bridge
    const bridge = new Bridge({
        registration: './registration.yaml',
        homeserverUrl: 'http://localhost:8008',
        domain: 'beefy',
        controller: {
            onEvent: (request, context) => onMatrixEvent(request, context)
        }
    });

    // Setup a simple webapp 
    const expressApp = express();
    expressApp.get('/twilio', async (req, res) => {
        res.status(200);
        const {Author, Body} = req.query;
        const entries = await bridge.getRoomStore().getEntriesByRemoteId(Author);
        for (const entry of entries) {
            const roomId = entry.matrix.getId();
            const intent = bridge.getIntentFromLocalpart('twilio_' + Author.replace('+', ''));
            await intent.sendText(roomId, Body);
        }
    });

    // Listen for webhooks from Twilio
    expressApp.listen(1338);
    // Listen for matrix events from Synapse
    await bridge.run(1337);
    console.log("Started up");
}

main().catch(err => console.log("Failed:", err));