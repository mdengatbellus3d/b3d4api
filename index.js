/*
 *  Javascript API for Bellus3d B3d4 dev API
 *  author: max@bellus3d
 *  created: Oct 23 2019
 */
import gltfutils from "./gltfutils";

// define built-in default message(event) handlers
// mainly for help maintaining session status.
// these function will be called in B3d4api instance's context
// i.e. 'this' will refer to a B3d4api instance
const defaultMessageHandlers = {
    "response:connect": function(msg) {
        this.sessionId = msg.session_id;
    },
    "response:station_list": function(msg) {
        this.stationList = msg.stations;
    },
    "response:station_select": function(msg) {},
    "response:preview_start": function(msg) {
        this.isPreviewing = true;
    },
    "response:preview_stop": function(msg) {
        this.isPreviewing = false;
    }
};

// Note to the format of "response:connect"
//     since the same request name "connect" appears in
//     both side of client request & server response,
//     we use an addition field to tell the difference,
//     instead of using two separate handler collections
// Also, in this system,
//     each message(event) can have multiple handlers working together,
//     user can add handlers multiple times,
//     or remove all user-defined handlers,
//     but the built-in handler will always be there.

//
// B3D4 websocket dev API client
class B3d4api {
    constructor(host) {
        this.host = host;
        this.ws = null;
        // session information
        this.sessionId = null;
        this.stationList = null;
        this.currentStation = null;
        this.isPreviewing = false;
        // message handlers
        this.messageHandlers = {};
        // current open requests waiting for server responses
        this.openClientRequests = {};
        // set built-in handlers
        this._setDefaultMessageHandlers();
    }

    // private method: set default handler for some messages
    _setDefaultMessageHandlers() {
        for (let key in defaultMessageHandlers) {
            this._setMessageHandler(key, defaultMessageHandlers[key]);
        }
    }

    // private method: general handler setter
    _setMessageHandler(key, handler) {
        if (!this.messageHandlers[key]) {
            // leave space for built-in handler
            this.messageHandlers[key] = [function() {}];
        }
        // remove all message handlers if (handler === null)
        if (!handler) {
            // but alway keep the first one, which is the built-in handler
            this.messageHandlers[key] = this.messageHandlers[key].slice(1);
        } else {
            this.messageHandlers[key].push(handler);
        }
    }

    // private method: call message handlers
    _callMessageHandler(key, msg) {
        let handlers = this.messageHandlers[key] ? this.messageHandlers[key] : [];
        handlers.forEach(handler => {
            handler.call(this, msg);
        });
    }

    // private method: register request
    // when reponses to these requests arrived, promise will be fullfiled
    _registerClientRequest(request_id, resolve, reject) {
        // currently, the system doesn't support request_id,
        // instead we use 'request name' as a temporary solution,
        // so only 1 request of same request type will be kept
        this.openClientRequests[request_id] = { resolve, reject };
    }

    // when reponses received from dev API server,
    // this function will be called to resolve the request promise,
    _resolveClientRequest(request_id, success, msg) {
        let entry = this.openClientRequests[request_id];
        if (entry) {
            let { resolve, reject } = entry;
            // delete it from registery
            delete this.openClientRequests[request_id];
            // fullfil it
            success ? resolve(msg) : reject(msg);
        }
    }

    // handle request from host
    handleServerRequest(request, msg) {
        this._callMessageHandler(`request:${request}`, msg);
    }

    // handle response from host
    handleServerResponse(response, msg) {
        this._callMessageHandler(`response:${response}`, msg);
    }

    // set handlers for requests from host server
    onServerRequest(request, handler) {
        this._setMessageHandler(`request:${request}`, handler);
    }

    // set handlers for responses from host server
    onServerResponse(response, handler) {
        this._setMessageHandler(`response:${response}`, handler);
    }

    // set handler for onopen event, treat it as a special message
    onConnectionOpen(handler) {
        this._setMessageHandler(`connection:open`, handler);
    }

    // set handler for onclose event, treat it as a special message
    onConnectionClose(handler) {
        this._setMessageHandler(`connection:close`, handler);
    }

    // send general message to host
    sendMessage(msg) {
        if (!this.sessionId) return;
        msg.session_id = this.sessionId;
        this.ws.send(JSON.stringify(msg));
    }

    // send general message to host, and
    // expecting a response
    sendRequest(msg, timeout) {
        if (!this.sessionId || !msg.request) return;
        // send out the message
        this.sendMessage(msg);
        // register the request, so that
        // we can wait for it's response
        let { request } = msg;
        return new Promise((resolve, reject) => {
            this._registerClientRequest(request, resolve, reject);
            if (timeout) {
                setTimeout(() => {
                    // reject the request
                    // will be ignored if request already resolved
                    this._resolveClientRequest(request, false, {
                        session_id: this.sessionId,
                        message: "timed out"
                    });
                }, timeout);
            }
        });
    }

    // start B3d4 websocket API connection
    start(host) {
        if (host) this.host = host;

        // start websocket session
        this.ws = new WebSocket(this.host);

        // treat onopen as a special message
        this.ws.onopen = event => {
            this._callMessageHandler(`connection:open`, event);
        };

        // treat onclose as a special message
        this.ws.onclose = event => {
            this._callMessageHandler(`connection:close`, event);
        };

        // main message handler entry
        // this function will dispatch messages to handlers
        // defined in this.messageHandlers
        this.ws.onmessage = e => {
            let msg = e.data;
            // console.log(msg);
            // need to check the type of message
            // we may receive two types of messages from the host server,
            // (1) a gltf frame,  OR (2) a serialized json string

            // it's a gltf frame
            if (typeof msg === "object") {
                gltfutils.parseGltfBlob(msg).then(gltf => {
                    // console.log({ type: "GLTF", gltf });
                    const { request, camera } = gltf.event;
                    const frame = gltfutils.uint8ToBlog(gltf.data);
                    if (request === "buffer_capture") {
                        this.handleServerRequest("camera_snap", { camera, frame });
                    } else {
                        this.handleServerRequest("camera_frame", { camera, frame });
                    }
                });
            }

            // it's a string, expecting a valid json string
            else {
                msg = JSON.parse(msg);
                // console.log({ type: "JSON", msg });

                if (msg.response_to) {
                    // if it's an open respose,
                    // resolve the waiting promise
                    this._resolveClientRequest(msg.response_to, true, msg);
                    this.handleServerResponse(msg.response_to, msg);
                } else if (msg.request) {
                    this.handleServerRequest(msg.request, msg);
                }
            }
        };

        // return a promise, it won't resolve until
        // the server response a 'connect' message with a session_id in it
        return new Promise((resolve, reject) => {
            this._registerClientRequest("connect", resolve, reject);
        });
    }

    // clear current status and restart websocket connection
    restart() {
        if (!this.host) return;
        // reset session
        if (this.ws) {
            this.ws.close();
        }
        // clear current status
        this.sessionId = null;
        this.stationList = null;
        this.currentStation = null;
        this.isPreviewing = false;
        this.openClientRequests = {};
        return this.start();
    }

    // send 'session_init' request, and expecting a response of promise
    initSession(timeout = null) {
        return this.sendRequest(
            {
                request: "session_init"
            },
            timeout
        );
    }

    // send 'station_list' request, and expecting a response of promise
    listStations(timeout = null) {
        return this.sendRequest(
            {
                request: "station_list"
            },
            timeout
        );
    }

    // send 'station_select' request, and expecting a response of promise
    selectStation(stationId, timeout = null) {
        return this.sendRequest(
            {
                request: "station_select",
                station_id: stationId
            },
            timeout
        );
    }

    // send 'preview_start' request, and expecting a response of promise
    startPreview(timeout = null) {
        if (this.isPreviewing) return Promise.resolve({});
        return this.sendRequest(
            {
                request: "preview_start",
                source: "COLOR",
                format: "JPEG",
                dimension: "240x320",
                camera: "c",
                frames: 0,
                tracking: "FACE"
            },
            timeout
        );
    }

    // send 'preview_stop' request, and expecting a response of promise
    stopPreview(timeout = null) {
        if (!this.isPreviewing) return Promise.resolve({});
        return this.sendRequest(
            {
                request: "preview_stop"
            },
            timeout
        );
    }

    // send 'scan_record' request, and expecting a response of promise
    startRecording(timeout = null) {
        if (this.isPreviewing) this.stopPreview();
        return this.sendRequest(
            {
                request: "scan_record"
                // cameras: ["c"],
            },
            timeout
        );
    }

    // send 'scan_process' request, and expecting a response of promise
    processBuffer(bufferId, timeout = null, debug = false) {
        if (this.isPreviewing) this.stopPreview();
        return this.sendRequest(
            {
                request: "scan_process",
                scan_id: bufferId,
                type: "HEADMODEL",
                // formats: [],
                debug
            },
            timeout
        );
    }

    // send 'release_scan' request, and expecting a response of promise
    releaseBuffer(bufferId, timeout = null) {
        return this.sendRequest(
            {
                request: "scan_release",
                scan_id: bufferId
            },
            timeout
        );
    }

    // send 'camera_status' request, and expecting a response of promise
    getCameraStatus(timeout = null) {
        if (this.isPreviewing) this.stopPreview();
        return this.sendRequest(
            {
                request: "camera_status"
            },
            timeout
        );
    }
}

export default B3d4api;