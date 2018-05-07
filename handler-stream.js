
const {JpegsToLiveRtmp} = require('./module-transcode.js');
const {HttpMjpegStream, HttpWavStream} = require('./module-httpStream.js');

module.exports = class LiveStreamHandler 
{
	constructor(env) 
	{
		this.handlerName = 'stream';
		this.isCenter = env.get('isCenter');
		this.config = env.get('getConfig')();
		this.configs = env.get('configs');
		this.nodeId = env.get('nodeId');
		this.cache = env.get('newCache')();

		this._buf_mjchk = null;

		if (!this.isCenter) {
			console.log( this.handlerName, ' didn\'t run in center node');
			return;
		}

		this.init();
	}

	init()
	{
		this.streamMjpeg = this.config.streamMjpeg || 'seed.mjpeg';
		this.streamWav = this.config.streamWav || 'seed.wav';

		this.mjpegLive = new HttpMjpegStream('/'+this.handlerName+'/'+this.streamMjpeg);
		this.wavLive = new HttpWavStream('/'+this.handlerName+'/'+this.streamWav);

		this.mjpegPushTime = 0;
		this.pcmPushTime = 0;
	}

	getPushType( socket )
	{
		let reqCmd = socket.incomingUrl.split('/').filter(e=>e.trim() != '');
		let typeStr = reqCmd.pop();

		if ( ['pcm', 'mjpeg', 'mp3', 'mp4'].includes( typeStr )) {
			return typeStr;
		}

		return null;
	}

	websocket( socket, data ) 
	{
		if ( data === null ) {
			console.log( 'new connect incoming' );

			let reqCmd = socket.incomingUrl.split('/').filter(e=>e.trim() != '');
			let pushType = reqCmd.pop();

			if ( ! ['pcm', 'mjpeg'].includes( pushType )) {
				console.log( 'push type error, close connection' );
				socket.close();
				return;
			}

			socket.pushType = pushType;

			socket.on('close', (code, message) => {
				console.log(this.handlerName + ' close ' + socket.uuid);
			});

			socket.on('error', (err)=> {
				console.log(this.handlerName + ' error ' + socket.uuid + ' : ' + err);
			});

			return;
		}

		switch (socket.pushType) {
		    case 'mjpeg':
			this.mjpegPushTime = Date.now();
			this.mjpegLive.feed( data );
			break;
		    case 'pcm':
			this.pcmPushTime = Date.now();
			this.wavLive.feed( data );
			break;
		    default:
			console.log( 'unknow error, pushType: ' + socket.pushType );
		}
	}

	http( req, res )
	{
		if ( this.mjpegLive.init( req, res )) {
			return;
		}

		if ( this.wavLive.init( req, res )) {
			return;
		}

		res.json({ status: 'ok', message: this.handlerName + ' handler responses' });
	}

	infos () 
	{
		return {
			startTime: 0,
			restartTimes: 0
		};
	}

	feedImage( chunk ) 
	{
		if ( (Date.now() - this.mjpegPushTime) < 1000 ) {
			return;
		}


		var _len = chunk.length;


		// mjpeg header 
		if(chunk[0] == 0xff && chunk[1] == 0xd8) {

			// mjpeg tailer 
			if(chunk[_len - 2] == 0xff && chunk[_len - 1] == 0xd9) {
				// is complete frame, sent
				this.mjpegLive.feed( chunk );
				this._buf_mjchk  = null;
			} else {
				// incomplete frame, set in buffer
				this._buf_mjchk = chunk;
			}

		} else {

			// incomplete chunk, concat buffer
			if(this._buf_mjchk ) {
				this._buf_mjchk = Buffer.concat([this._buf_mjchk, chunk])


				// current chunk is tailer
				if(chunk[_len - 2] == 0xff && chunk[_len - 1] == 0xd9) {

					// is complete frame, sent
					this.mjpegLive.feed(this._buf_mjchk);
					this._buf_mjchk = null;
					// console.log("sent concated frame.")
				}
			} else {
				console.log("incomplete frame without concat , droped .")
			}
		}
	}

	feedPCM( chunk ) 
	{
		if ( (Date.now() - this.pcmPushTime) < 1000 ) {
			return;
		}

		this.wavLive.feed( chunk );
	}

	onDownRequest (socket, req) 
	{
		let userId = req.userId;
		 
		 switch (req.cmd) {
		 	case 'active':
				break;

			case 'intra':
				break;

			default:
				console.log('cmd not handled: ', req);
		 }
	}
};

