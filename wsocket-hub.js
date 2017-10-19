
const express = require('express');
const http = require('http');
const url = require('url');
const WebSocket = require('ws');
const machineIdSync = require('node-machine-id').machineIdSync;
const crypto = require('crypto');

const UPSTREAM_RECONNECT_INTERVAL = 300;

class WebSocketHub 
{
	constructor(port) 
	{
		this.handlers = new Array();
		this.env = new Map(); 
		this.port = port;

		let app = express();
		app.use(express.static('public'));
		app.use(function (req, res) {
			res.send({ msg: "hello" });
		});

		this.webServer = http.createServer(app);
		this.socketServer = new WebSocket.Server({ server: this.webServer });

		this.socketServer.connectionCount = 0;

		this.socketServer.on('connection', (function(socket, upgradeReq) {
			this.socketServer.connectionCount++;
			console.log('New ImageFeed Connection: ' + this.socketServer.connectionCount+' total)');

			socket.on('close', (function(code, message){
				this.socketServer.connectionCount--;
				console.log('Disconnected ImageFeed('+this.socketServer.connectionCount+' total)');
			}).bind(this));

			socket.on('message', (function(dataStr){
				let req = null;
				try {
					req = JSON.parse(dataStr);
				} catch (e) {
				}

				req && this.onDownRequest(socket, req);
			}).bind(this));

			socket.on('error', function(err){
				console.log('image feed err: '+err);	
			});

			this.handlers.forEach(function(handler) {
				if (typeof handler.onDownConnect === "function") { 
					handler.onDownConnect(socket);
				}
			});

		}).bind(this));

		this.webServer.listen(this.port, function listening() {
			console.log('Listening on %d', this.port);
		}.bind(this));

		this.env.set('server', this.socketServer);
		this.env.set('eachClient', this.eachClient.bind(this));
		this.env.set('nodeId', this.getNodeId());
	}

	getNodeId () 
	{
		if (typeof this.nodeId === 'undefined') {
			let data = machineIdSync() + this.port;
			this.nodeId = crypto.createHash('md5').update(data).digest("hex");
		}
		return this.nodeId;
	}

	feed (chunk) 
	{
		this.handlers.forEach(function(handler) {
			if (typeof handler.feed === "function") { 
				handler.feed(chunk);
			}
		});
	}

	onDownRequest (socket, req)
	{
		this.handlers.some(function(handler) {
			if (handler.handlerName !== req.handler) {
				return false;
			}

			do {
				if (typeof handler.onDownRequest !== "function") break;
				if (!req.hasOwnProperty('cmd')) break;
				if (!req.hasOwnProperty('user_id')) break;
				handler.onDownRequest(socket, req);
			} while (false);
			return true;
		});
	}

	addHandler (Handler) 
	{
		this.handlers.push(new Handler(this.env));
	}

	eachClient (callback) 
	{
		this.socketServer.clients.forEach(function each(client) {
			if (client.readyState === WebSocket.OPEN) {
				callback(client);
			}
		});

	}

	broadcast (chunk) 
	{
		this.socketServer.clients.forEach(function each(client) {
			if (client.readyState === WebSocket.OPEN) {
				client.send(chunk);
			}
		});
	}

	upstream (url, interval = UPSTREAM_RECONNECT_INTERVAL) 
	{
		let handlers = this.handlers;
		this.wsClient(url, interval, function recv(data){
			handlers.forEach(function(handler) {
				if (data === null) {
					if (typeof handler.onUpConnect === "function") { 
						handler.onUpConnect(this.socket);
					}
					return;
				}

				if (typeof handler.onUpResponse !== "function") { 
					return;
				}

				let dataView = new DataView(data);
				let signs = [dataView.getUint8(0), dataView.getUint16(0)];

				if (signs.includes(handler.chunkHead)) {
					handler.onUpResponse (data, this.socket);
				}
			}, this);
		});
	}

	wsClient(url, interval, recv) 
	{
		var WSClient = function() {
			this.url = url;
			this.interval = interval;
			this.reconnectTimeoutId = 0;
			this.recv = recv;
		};

		WSClient.prototype.start = function() {
			this.socket = new WebSocket(this.url, {
				perMessageDeflate: false
			});

			this.socket.binaryType = 'arraybuffer';

			this.socket.on('message', function incoming(data) {
				this.recv(data);
			}.bind(this));

			this.socket.on('open', function open(){
				this.recv(null);
			}.bind(this));

			this.socket.on('error', this.onClose.bind(this));
			this.socket.on('close', this.onClose.bind(this));
			return this;
		};

		WSClient.prototype.onClose = function(ev) {
			clearTimeout(this.reconnectTimeoutId);
			this.reconnectTimeoutId = setTimeout(function(){
				this.start();	
			}.bind(this), this.interval);
		};

		WSClient.prototype.send = function(data) {
			this.socket.send(data);
		};

		return new WSClient().start();
	}
}

module.exports = WebSocketHub;
