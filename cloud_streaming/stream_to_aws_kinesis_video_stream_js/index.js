const express = require('express');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const WebSocket = require('ws');
const dotenv = require('dotenv');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');

// AWS SDK imports for SigV4 signing
const { SignatureV4 } = require('@aws-sdk/signature-v4');
const { HttpRequest } = require('@aws-sdk/protocol-http');
const { Sha256 } = require('@aws-crypto/sha256-js');
const { defaultProvider } = require('@aws-sdk/credential-provider-node');


// choose either GStreamer or PutMedia producer 

// Custom KVS GStreamer functions
// const { startStream,sendAudioBuffer, sendVideoBuffer } = require('./kvs_gstreamer_stream_audio_and_video_with_ffmpeg.js');
// Custom KVS PutMedia producer
// const { startStream, sendAudioBuffer, sendVideoBuffer } = require('./kvs_putmedia_producer_stream_audio_and_video_with_ffmpeg.js');

// Load environment variables from a .env file
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const execAsync = promisify(exec);

const ZOOM_SECRET_TOKEN = process.env.ZOOM_SECRET_TOKEN;
const CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook';

// Configuration object
const config = {
    mode: process.env.MODE || 'webhook',
    webhookPath: WEBHOOK_PATH,
    zoomSecretToken: ZOOM_SECRET_TOKEN,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    zoomEventWSSUrl: process.env.ZOOM_EVENT_WSS_URL
};

// Placeholder for shared services (can be expanded as needed)
const sharedServices = {};

// Middleware to parse JSON bodies in incoming requests
app.use(express.json());

// Map to keep track of active WebSocket connections and audio chunks
const activeConnections = new Map();


// Handle POST requests to the webhook endpoint
app.post(WEBHOOK_PATH, (req, res) => {
    // Respond with HTTP 200 status
    res.sendStatus(200);
    console.log('RTMS Webhook received:', JSON.stringify(req.body, null, 2));
    const { event, payload } = req.body;

    // Handle URL validation event
    if (event === 'endpoint.url_validation' && payload?.plainToken) {
        // Generate a hash for URL validation using the plainToken and a secret token
        const hash = crypto
            .createHmac('sha256', ZOOM_SECRET_TOKEN)
            .update(payload.plainToken)
            .digest('hex');
        console.log('Responding to URL validation challenge');
        return res.json({
            plainToken: payload.plainToken,
            encryptedToken: hash,
        });
    }

    // Handle RTMS started event
    if (event === 'meeting.rtms_started') {
        console.log('RTMS Started event received');
        const { meeting_uuid, rtms_stream_id, server_urls } = payload;
        // Initiate connection to the signaling WebSocket server
        connectToSignalingWebSocket(meeting_uuid, rtms_stream_id, server_urls);
    }

    // Handle RTMS stopped event
    if (event === 'meeting.rtms_stopped') {
        console.log('RTMS Stopped event received');
        const { meeting_uuid } = payload;

        // Close all active WebSocket connections for the given meeting UUID
        if (activeConnections.has(meeting_uuid)) {
            const connections = activeConnections.get(meeting_uuid);
            for (const conn of Object.values(connections)) {
                if (conn && typeof conn.close === 'function') {
                    conn.close();
                }
            }
            activeConnections.delete(meeting_uuid);
        }
    }
});

if (config.mode === 'websocket') {
    (async () => {
        console.log("websocket mode");
        const baseWsUrl = config.zoomEventWSSUrl;
        const clientId = config.clientId;
        const clientSecret = config.clientSecret;

        if (!baseWsUrl || !clientId || !clientSecret) {
            console.error('❌ Missing required env vars: ZOOM_EVENT_WS_BASE, ZOOM_CLIENT_ID, or ZOOM_CLIENT_SECRET');
            return;
        }

        // === Get Zoom Access Token (client_credentials grant) ===
        const accessToken = await new Promise((resolve, reject) => {
            const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
            const options = {
                method: 'POST',
                hostname: 'zoom.us',
                path: '/oauth/token?grant_type=client_credentials',
                headers: {
                    'Authorization': `Basic ${credentials}`
                }
            };

            const req = https.request(options, res => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        const tokenData = JSON.parse(body);
                        console.log('✅ Zoom access token received.');
                        resolve(tokenData.access_token);
                    } else {
                        console.error(`❌ Zoom token request failed: ${res.statusCode} ${body}`);
                        resolve(null);
                    }
                });
            });

            req.on('error', (err) => {
                console.error('❌ HTTPS error requesting token:', err.message);
                resolve(null);
            });

            req.end();
        });

        if (!accessToken) {
            console.error('No access token returned');
            return;
        }

        // === Connect to WebSocket ===
        const fullWsUrl = `${baseWsUrl}&access_token=${accessToken}`;
        console.log(`🔗 Full WebSocket URL: ${fullWsUrl}`);

        const ws = new WebSocket(fullWsUrl);

        ws.on('open', () => {
            console.log('✅ WebSocket connection established.');
            ws.send(JSON.stringify({ module: 'heartbeat' }));
            console.log('💓 Sent initial heartbeat');

            const interval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ module: 'heartbeat' }));
                    console.log('💓 Heartbeat sent');
                } else {
                    clearInterval(interval);
                }
            }, 30000);
        });

        ws.on('message', async (message) => {
            console.log('📥 Received message from Zoom Event WebSocket');
            console.debug(`🔍 Raw Message:\n${message}`);

            try {
                const msg = JSON.parse(message);

                // Respond to keep-alive requests
                if (msg.msg_type === 12) { // KEEP_ALIVE_REQ
                    console.log('Event KEEP_ALIVE_REQ Message:', JSON.stringify(msg, null, 2));
                    mediaWs.send(
                        JSON.stringify({
                            msg_type: 13, // KEEP_ALIVE_RESP
                            timestamp: msg.timestamp,
                        })
                    );
                    console.log('Responded to Event KEEP_ALIVE_REQ');
                }

                if (msg.module === 'message' && msg.content) {
                    const eventData = JSON.parse(msg.content);
                    const event = eventData.event;
                    const payload = eventData.payload || {};

                    console.log(`🧠 Parsed Event: ${event}`);
                    console.debug(`📦 Payload:`, payload);

                    if (event === 'meeting.rtms_started') {
                        console.log('RTMS Started event received');
                        const { meeting_uuid, rtms_stream_id, server_urls } = payload;

                        // Initiate connection to the signaling WebSocket server
                        connectToSignalingWebSocket(meeting_uuid, rtms_stream_id, server_urls);
                    }

                    // Handle RTMS stopped event
                    if (event === 'meeting.rtms_stopped') {
                        console.log('RTMS Stopped event received');
                        const { meeting_uuid } = payload;

                        // Close all active WebSocket connections for the given meeting UUID
                        if (activeConnections.has(meeting_uuid)) {
                            const connections = activeConnections.get(meeting_uuid);
                            for (const conn of Object.values(connections)) {
                                if (conn && typeof conn.close === 'function') {
                                    conn.close();
                                }
                            }
                            activeConnections.delete(meeting_uuid);
                        }
                    }
                }
            } catch (err) {
                console.error('❌ Error processing message:', err.message);
            }
        });

        ws.on('error', (err) => {
            console.error(`⚠️ WebSocket Error: ${err.message}`);
        });

        ws.on('close', (code, reason) => {
            console.warn(`🔌 WebSocket closed | Code: ${code}, Reason: ${reason}`);
        });
    })();
} else {
    console.error('❌ Invalid mode specified in config');
}

// Function to generate a signature for authentication
function generateSignature(CLIENT_ID, meetingUuid, streamId, CLIENT_SECRET) {
    console.log('Generating signature with parameters:');
    console.log('meetingUuid:', meetingUuid);
    console.log('streamId:', streamId);

    // Create a message string and generate an HMAC SHA256 signature
    const message = `${CLIENT_ID},${meetingUuid},${streamId}`;
    return crypto.createHmac('sha256', CLIENT_SECRET).update(message).digest('hex');
}

// Function to connect to the signaling WebSocket server
function connectToSignalingWebSocket(meetingUuid, streamId, serverUrl) {
    console.log(`Connecting to signaling WebSocket for meeting ${meetingUuid}`);

    const ws = new WebSocket(serverUrl);

    // Store connection for cleanup later
    if (!activeConnections.has(meetingUuid)) {
        activeConnections.set(meetingUuid, {});
    }
    activeConnections.get(meetingUuid).signaling = ws;

    ws.on('open', () => {
        console.log(`Signaling WebSocket connection opened for meeting ${meetingUuid}`);
        const signature = generateSignature(
            CLIENT_ID,
            meetingUuid,
            streamId,
            CLIENT_SECRET
        );

        // Send handshake message to the signaling server
        const handshake = {
            msg_type: 1, // SIGNALING_HAND_SHAKE_REQ
            protocol_version: 1,
            meeting_uuid: meetingUuid,
            rtms_stream_id: streamId,
            sequence: Math.floor(Math.random() * 1e9),
            signature,
        };
        ws.send(JSON.stringify(handshake));
        console.log('Sent handshake to signaling server : ', JSON.stringify(handshake));
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        console.log('Signaling Message received:', JSON.stringify(msg, null, 2));

        // Handle successful handshake response
        if (msg.msg_type === 2 && msg.status_code === 0) { // SIGNALING_HAND_SHAKE_RESP
            const mediaUrl = msg.media_server?.server_urls?.all;
            console.log(' Media url :', mediaUrl);
            if (mediaUrl) {
                // Connect to the media WebSocket server using the media URL
                //connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, ws);

                // Start ingestion using the Inlet Service
                sendToKVS(mediaUrl, meetingUuid, streamId, ws);
            }
        }

        // Respond to keep-alive requests
        if (msg.msg_type === 12) { // KEEP_ALIVE_REQ
            console.log('Signaling KEEP_ALIVE_REQ Message:', JSON.stringify(msg, null, 2));
            const keepAliveResponse = {
                msg_type: 13, // KEEP_ALIVE_RESP
                timestamp: msg.timestamp,
            };
            console.log('Responding to Signaling KEEP_ALIVE_REQ:', keepAliveResponse);
            ws.send(JSON.stringify(keepAliveResponse));
            console.log('Signaling Message sent:', JSON.stringify(keepAliveResponse, null, 2));
        }
    });

    ws.on('error', (err) => {
        console.error('Signaling socket error:', err);
    });

    ws.on('close', () => {
        console.log('Signaling socket closed');
        if (activeConnections.has(meetingUuid)) {
            delete activeConnections.get(meetingUuid).signaling;
        }
    });
}

function sendToKVS(mediaUrl, meetingUuid, streamId, ws) {

    startIngestion({
        streamName: process.env.STREAM_NAME,
        zoomRtmsUri: mediaUrl,
        meetingUuid: meetingUuid,
        rtmsStreamId: streamId,
        region: process.env.AWS_REGION || 'us-west-2',
        inletServiceEndpoint: 'http://localhost:8080'
    }).then(response => {
        console.log('Ingestion started successfully:', response);

        // Send CLIENT_READY_ACK on signaling WebSocket to start streaming
        console.log('Sending CLIENT_READY_ACK to signaling server to start streaming');
        const clientReadyAck = {
            msg_type: 7, // CLIENT_READY_ACK
            rtms_stream_id: streamId,
        };
        ws.send(JSON.stringify(clientReadyAck));
        console.log('Signaling Message sent:', JSON.stringify(clientReadyAck, null, 2));

        // Store ingestion ID for tracking
        if (activeConnections.has(meetingUuid)) {
            activeConnections.get(meetingUuid).ingestionId = response.IngestionId;
        } else {
            activeConnections.set(meetingUuid, { ingestionId: response.IngestionId });
        }
    }).catch(error => {
        console.error('Failed to start ingestion:', error);
    });
}

// Function to connect to the media WebSocket server
function connectToMediaWebSocket(mediaUrl, meetingUuid, streamId, signalingSocket) {
    console.log(`Connecting to media WebSocket at ${mediaUrl}`);

    const mediaWs = new WebSocket(mediaUrl, { rejectUnauthorized: false });

    // Store connection for cleanup later
    if (activeConnections.has(meetingUuid)) {
        activeConnections.get(meetingUuid).media = mediaWs;
    }

    mediaWs.on('open', () => {
        const signature = generateSignature(
            CLIENT_ID,
            meetingUuid,
            streamId,
            CLIENT_SECRET
        );
        const handshake = {
            msg_type: 3, // DATA_HAND_SHAKE_REQ
            protocol_version: 1,
            meeting_uuid: meetingUuid,
            rtms_stream_id: streamId,
            signature,
            media_type: 32, // AUDIO+VIDEO+TRANSCRIPT
            payload_encryption: false,
            media_params: {
                audio: {
                    content_type: 1,
                    sample_rate: 1,
                    channel: 1,
                    codec: 1,
                    data_opt: 1,
                    send_rate: 100
                },
                video: {
                    codec: 7, //H264
                    resolution: 2,
                    fps: 25
                }
            }
        };
        console.log('Media Handshake : ', JSON.stringify(handshake));
        mediaWs.send(JSON.stringify(handshake));
    });

    mediaWs.on('message', (data) => {
        try {
            // Try to parse as JSON first
            const msg = JSON.parse(data.toString());
            // debugging
            // console.log('Media JSON Message:', JSON.stringify(msg, null, 2));

            // Handle successful media handshake
            if (msg.msg_type === 4 && msg.status_code === 0) { // DATA_HAND_SHAKE_RESP
                signalingSocket.send(
                    JSON.stringify({
                        msg_type: 7, // CLIENT_READY_ACK
                        rtms_stream_id: streamId,
                    })
                );
                console.log('Media handshake successful, sent start streaming request in signaling');
            }

            // Respond to keep-alive requests
            if (msg.msg_type === 12) { // KEEP_ALIVE_REQ
                console.log('Media KEEP_ALIVE_REQ Message:', JSON.stringify(msg, null, 2));
                mediaWs.send(
                    JSON.stringify({
                        msg_type: 13, // KEEP_ALIVE_RESP
                        timestamp: msg.timestamp,
                    })
                );
                console.log('Responded to Media KEEP_ALIVE_REQ');
            }

            // Handle audio data
            if (msg.msg_type === 14 && msg.content && msg.content.data) {             
                let { user_id, user_name, data: audioData } = msg.content;
                let buffer = Buffer.from(audioData, 'base64');
                let timestamp = Date.now();  // Use server timestamp
                const metadata = { user_id, user_name, timestamp };
                // console.debug ('Audio data received : ' + buffer);
                console.log(`Audio data received from ${user_name}: ${buffer.length} bytes`);
                // sendAudioBuffer(buffer);
              
            }
            // Handle video data
            if (msg.msg_type === 15 && msg.content && msg.content.data) {
                let { user_id, user_name, data: videoData } = msg.content;
                let buffer = Buffer.from(videoData, 'base64');
                let timestamp = Date.now();  // Use server timestamp
                const metadata = { user_id, user_name, timestamp };
                //  console.debug ('Video data received ' + buffer);
                console.log(`Video data received from ${user_name}: ${buffer.length} bytes`);
                // sendVideoBuffer(buffer);
                
            }
            // Handle transcript data
            if (msg.msg_type === 17 && msg.content && msg.content.data) {

            }
        } catch (err) {
            console.error('Error processing media message:', err);
        }
    });

    mediaWs.on('error', (err) => {
        console.error('Media socket error:', err);
    });

    mediaWs.on('close', () => {
        console.log('Media socket closed');
        if (activeConnections.has(meetingUuid)) {
            delete activeConnections.get(meetingUuid).media;
        }
    });
}


/**
 * Start Ingestion - Calls the AWS Acuity Inlet Service StartIngestion API
 * 
 * This function initiates ingestion from a Zoom RTMS stream to a Kinesis Video Stream
 * using the AWS Acuity Inlet Service. It handles AWS SigV4 signing automatically.
 * 
 * @param {Object} params - Parameters for starting ingestion
 * @param {string} params.streamName - KVS stream name (either this or streamARN required)
 * @param {string} params.streamARN - KVS stream ARN (alternative to streamName)
 * @param {string} params.zoomRtmsUri - Zoom RTMS WebSocket URI (from webhook payload)
 * @param {string} params.meetingUuid - Zoom meeting UUID
 * @param {string} params.rtmsStreamId - Zoom RTMS stream ID
 * @param {string} params.region - AWS region (e.g., 'us-west-2')
 * @param {string} params.inletServiceEndpoint - Inlet Service endpoint URL
 * @returns {Promise<Object>} StartIngestion response with ingestionId, streamARN, and status
 * 
 * @example
 * // Example usage in the webhook handler:
 * if (event === 'meeting.rtms_started') {
 *     const { meeting_uuid, rtms_stream_id, server_urls } = payload;
 *     
 *     try {
 *         const response = await startIngestion({
 *             streamName: process.env.STREAM_NAME,
 *             zoomRtmsUri: server_urls,
 *             meetingUuid: meeting_uuid,
 *             rtmsStreamId: rtms_stream_id,
 *             region: process.env.AWS_REGION || 'us-west-2',
 *             inletServiceEndpoint: process.env.INLET_SERVICE_ENDPOINT
 *         });
 *         
 *         console.log('Ingestion started:', response);
 *         // Response contains: { IngestionId, StreamARN, Status }
 *     } catch (error) {
 *         console.error('Failed to start ingestion:', error);
 *     }
 * }
 */
async function startIngestion(params) {
    const {
        streamName,
        streamARN,
        zoomRtmsUri,
        meetingUuid,
        rtmsStreamId,
        region = 'us-west-2',
        inletServiceEndpoint
    } = params;

    try {
        console.log('Starting ingestion for Zoom RTMS stream...');
        console.log('Parameters:', {
            streamName,
            streamARN,
            zoomRtmsUri,
            meetingUuid,
            rtmsStreamId,
            region
        });

        // Generate a unique client request token
        const clientRequestToken = crypto.randomUUID();

        // Generate signature on client-side (recommended for security)
        const signature = generateSignature(CLIENT_ID, meetingUuid, rtmsStreamId, CLIENT_SECRET);

        // Build the request payload according to StartIngestionInput structure
        const requestBody = {
            ClientRequestToken: clientRequestToken,
            ProducerStartTimestamp: Date.now(),
            FragmentTimecodeType: 'ABSOLUTE',
            IngestionConfiguration: {
                Protocol: 'WEBSOCKET',
                Uri: zoomRtmsUri,
                AuthConfiguration: {
                    Type: 'SIGNATURE',
                    Credentials: {
                        signature: signature,  // Pre-calculated signature (secure)
                        meetingUuid: meetingUuid,
                        streamId: rtmsStreamId
                    }
                },
                MediaConfiguration: {
                    VideoCodec: 'H264',
                    AudioCodec: 'PCM',
                    Resolution: 'HD',
                    Fps: 25
                },
                RetryConfiguration: {
                    MaxRetries: 3,
                    BackoffMultiplier: 2.0,
                    EnableAutoReconnect: true
                }
            },
            // NEW: IngestionMetadata - custom key-value pairs added to every MKV fragment
            IngestionMetadata: {
                // Meeting identifiers
                'MEETING_UUID': meetingUuid,
                'RTMS_STREAM_ID': rtmsStreamId,
                'INGESTION_TIMESTAMP': new Date().toISOString(),
            }
        };

        // Add stream identifier (either StreamName or StreamARN)
        if (streamName) {
            requestBody.StreamName = streamName;
        } else if (streamARN) {
            requestBody.StreamARN = streamARN;
        } else {
            throw new Error('Either streamName or streamARN must be provided');
        }

        // Parse the endpoint URL
        const endpointUrl = new URL(inletServiceEndpoint);
        const hostname = endpointUrl.hostname;
        const path = '/startIngestion';

        // Serialize the request body
        const body = JSON.stringify(requestBody);

        // Create the HTTP request
        const request = new HttpRequest({
            method: 'POST',
            protocol: endpointUrl.protocol,
            hostname: hostname,
            port: endpointUrl.port,
            path: path,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body).toString(),
                'Host': hostname
            },
            body: body
        });

        // Get AWS credentials
        const credentialsProvider = defaultProvider();
        const credentials = await credentialsProvider();

        // Create SigV4 signer
        const signer = new SignatureV4({
            service: 'kinesisvideo',
            region: region,
            credentials: credentials,
            sha256: Sha256
        });

        // Sign the request with AWS SigV4
        const signedRequest = await signer.sign(request);

        console.log('Request signed with AWS SigV4');

        // Determine which module to use based on protocol
        const isHttps = endpointUrl.protocol === 'https:';
        const httpModule = isHttps ? https : http;
        const defaultPort = isHttps ? 443 : 8080;

        // Make the HTTP/HTTPS request
        return new Promise((resolve, reject) => {
            const options = {
                hostname: signedRequest.hostname,
                port: signedRequest.port || defaultPort,
                path: signedRequest.path,
                method: signedRequest.method,
                headers: signedRequest.headers
            };

            const req = httpModule.request(options, (res) => {
                let responseBody = '';

                res.on('data', (chunk) => {
                    responseBody += chunk;
                });

                res.on('end', () => {
                    console.log(`StartIngestion response status: ${res.statusCode}`);

                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const response = JSON.parse(responseBody);
                            console.log('StartIngestion successful:', response);
                            resolve(response);
                        } catch (err) {
                            console.error('Failed to parse response:', err);
                            reject(new Error('Invalid JSON response'));
                        }
                    } else {
                        console.error('StartIngestion failed:', responseBody);
                        reject(new Error(`StartIngestion failed with status ${res.statusCode}: ${responseBody}`));
                    }
                });
            });

            req.on('error', (err) => {
                console.error('HTTPS request error:', err);
                reject(err);
            });

            // Write the request body
            req.write(signedRequest.body);
            req.end();
        });

    } catch (error) {
        console.error('Error in startIngestion:', error);
        throw error;
    }
}

// Start the server and listen on the specified port
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log(`Webhook endpoint available at http://localhost:${port}${WEBHOOK_PATH}`);

    //this is for putmedia producer
    // startStream();
});

// Export the startIngestion function for external use
module.exports = { startIngestion };
