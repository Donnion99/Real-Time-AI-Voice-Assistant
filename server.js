const express = require("express");
const PlayHT = require('playht');
const http = require("http");
const { getGroqChat } = require('./models/groq');
const WebSocket = require("ws");
const fs = require('fs');
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const dotenv = require("dotenv");
const { play, initialize } = require('./models/playht');
// const { neets } = require('./models/neets');

dotenv.config();

// Validate environment variables
const requiredEnvVars = ['DEEPGRAM_API_KEY', 'GROQ_API_KEY', 'PLAY_API_KEY', 'PLAY_USERID'];
const missingVars = requiredEnvVars.filter(key => !process.env[key]);
if (missingVars.length > 0) {
  console.error(`Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

// Initialize PlayHT
PlayHT.init({
  apiKey: process.env.PLAY_API_KEY,
  userId: process.env.PLAY_USERID,
});

// Updated stack for EmoBuddy
let stack = [{
  role: 'system',
  content: `You are a mental health support assistant named EmoBuddy. Your role is to provide emotional support and guidance to users.

Your tasks include:
1. Listening to users and understanding their emotions.
2. Asking thoughtful questions to help users explore their feelings.
3. Offering supportive and empathetic responses to help users feel heard and validated.
4. Providing appropriate resources or suggesting coping strategies based on the user's needs.

Key points to remember:
- Use a warm and empathetic tone throughout the conversation.
- Begin by asking the user how they are feeling and what’s on their mind.
- Ask open-ended questions to encourage the user to share more about their emotions and experiences.
- Offer support and validation, acknowledging the user's feelings without making judgments.
- If the user needs specific resources or strategies, provide gentle guidance on where they might find additional help or how they can manage their emotions.
- Avoid making the conversation too clinical; aim for a natural, conversational flow that feels personal and caring.

Your responses should be:
- Empathetic and supportive.
- Open-ended and engaging, to encourage further discussion.
- Clear and concise, avoiding overly complex language.

If the user expresses a need for immediate help or crisis support, direct them to appropriate emergency resources or hotlines. Always prioritize their safety and well-being.

Remember, your goal is to help the user feel understood and supported. Keep the conversation flowing naturally and compassionately.`,
}];


let keepAlive;
let count = 0;
let sid1 = 0;
let sid2 = 0;
let pl1 = 0;
let pl2 = 0;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);

function log(message) {
  const text = `${new Date().toISOString()} : ${message}\n`;
  fs.appendFile('./logs.txt', text, err => {
    if (err) console.error('Failed to write log:', err);
  });
}

initialize();

const setupDeepgram = (ws) => {
  async function playh(responseText) {
    console.time('play_api');
    const stream = await play(responseText);
    pl2++;
    sid2++;
    ws.send(JSON.stringify({ 'type': 'audio_session', 'sid1': sid1, 'sid2': sid2 }));
    if (pl1 === pl2) play_stream(stream);
  }

  function play_stream(stream) {
    stream.on("data", (chunk) => {
      const buffer = Uint8Array.from(chunk).buffer;
      ws.send(JSON.stringify({
        'type': 'audio',
        'output': Array.from(new Uint8Array(buffer)),
        'sid1': sid1,
        'sid2': sid2
      }));
    });
    console.timeEnd('play_api');
  }

  const deepgram = deepgramClient.listen.live({
    language: "en",
    punctuate: true,
    smart_format: true,
    model: "nova-2-phonecall",
    endpointing: 400
  });

  if (keepAlive) clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    deepgram.keepAlive();
  }, 10 * 1000);

  deepgram.addListener(LiveTranscriptionEvents.Open, () => {
    console.log("deepgram: connected");
    log('deepgram: connected');
  });

  deepgram.addListener(LiveTranscriptionEvents.Transcript, async (data) => {
    if (data.is_final && data.channel.alternatives[0].transcript !== "") {
      if (count > 0 && sid1 !== sid2) {
        console.log('Stopping the audio');
        ws.send(JSON.stringify({ 'type': 'audio_stop', 'stop': true }));
      }
      count++;
      sid1 = count;
      pl1++;
      ws.send(JSON.stringify({ 'type': 'audio_session', 'sid1': sid1 }));

      const words = data.channel.alternatives[0].words;
      const caption = words
        .map(word => word.punctuated_word ?? word.word)
        .join(" ");
      console.log(caption);
      log(`deepgram_spoken: ${caption}`);
      ws.send(JSON.stringify({ 'type': 'caption', 'output': JSON.stringify(caption) }));
      const regex = /disconnect/i;
      if (regex.test(caption)) {
        ws.send(JSON.stringify({ 'type': 'caption', 'output': JSON.stringify('#assistant stopped#') }));
        deepgram.finish();
        ws.close();
      } else {
        const responseText = await getGroqChat(caption, stack);
        log(`groq response: ${responseText}`);
        await playh(responseText);
        // await neets(responseText);
      }
    }
  });

  deepgram.addListener(LiveTranscriptionEvents.Close, () => {
    console.log("deepgram: disconnected");
    log('deepgram: disconnected');
    clearInterval(keepAlive);
    deepgram.finish();
  });

  deepgram.addListener(LiveTranscriptionEvents.Error, (error) => {
    console.log("deepgram: error received");
    console.error(error);
  });

  deepgram.addListener(LiveTranscriptionEvents.Warning, (warning) => {
    console.log("deepgram: warning received");
    console.warn(warning);
  });

  deepgram.addListener(LiveTranscriptionEvents.Metadata, (data) => {
    console.log("deepgram: packet received");
    console.log("deepgram: metadata received");
    console.log("ws: metadata sent to client");
    ws.send(JSON.stringify({ metadata: data }));
  });

  return deepgram;
};

wss.on("connection", (ws) => {
  console.log("socket: client connected");
  log('socket: client connected');
  let deepgram = setupDeepgram(ws);

  ws.on("message", (message) => {
    if (deepgram.getReadyState() === 1 /* OPEN */) {
      deepgram.send(message);
    } else if (deepgram.getReadyState() >= 2 /* 2 = CLOSING, 3 = CLOSED */) {
      console.log("socket: data couldn't be sent to deepgram");
      console.log("socket: retrying connection to deepgram");
      log('reattempting to send data');
      deepgram.finish();
      deepgram.removeAllListeners();
      deepgram = setupDeepgram(ws);
    } else {
      console.log("socket: data couldn't be sent to deepgram");
    }
  });

  ws.on("close", () => {
    console.log("socket: client disconnected");
    log('socket: client disconnected');
    deepgram.finish();
    deepgram.removeAllListeners();
    deepgram = null;
  });
});

app.use(express.static("public/"));
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

server.listen(3000, () => {
  console.log("Server is listening on port 3000");
});
