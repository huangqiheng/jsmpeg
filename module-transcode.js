const ffmpeg = require('fluent-ffmpeg');
const ffprobe = require('node-ffprobe');
const PassThroughStream = require('stream').PassThrough;
const uuidv1 = require('uuid/v1');
const fs = require('fs');
const mkdirp = require('mkdirp');
const mkfifoSync = require('mkfifo').mkfifoSync;

const SOI = new Buffer([0xff, 0xd8]);
const EOI = new Buffer([0xff, 0xd9]);

class MjpegStreamToJpegs
{
	constructor( config, jpegCallback ) 
	{
		if (!Buffer.prototype['indexOf']) bufferTools.extend();
		this.jpegCallback = jpegCallback;
		this._buffer = null;
		this.config = config;
	}

	checkpoint( chunk ) 
	{
		if (this.config.enableMjpegScan === false) {
			this.jpegCallback(chunk);
			return;
		}

		let image = null;
		let imgStart, imgEnd;
		while (chunk) {
			if (this._buffer === null) {
				chunk = (-1 != (imgStart = chunk.indexOf(SOI))) ? chunk.slice(imgStart) : null;
				if (chunk) this._buffer = new Buffer(0);
				continue;
			}

			if (-1 != (imgEnd = chunk.indexOf(EOI))) {
				imgEnd += EOI.length;
				image = Buffer.concat([this._buffer, chunk.slice(0, imgEnd)]);
				this.jpegCallback(image);
				this._buffer = null;
				chunk = chunk.slice(imgEnd);
				continue;
			}

			this._buffer = Buffer.concat( [this._buffer, chunk] );
			chunk = null;
		}
	}

	flush() {
		this._buffer = null;
	}
}

class ChunksFromFFmpegBase
{
	constructor( config, chunksCallback ) 
	{
		this.config = config || {};
		this.jobId =  uuidv1();
		this.output = new PassThroughStream();
		this.output.on('data', chunksCallback );
		this.output.on('error', this.onError.bind(this));
		this.command = null;

		mkdirp.sync('/tmp/jsmpeg');
	}

	log( title, ...msg ){
		this.config.debug &&  console.log( title, ...msg );
	}

	onFFmpegStart( cmdline ) {
		this.log( this.constructor.name, cmdline);
	}

	onFFmepgEnd () {
		this.log( this.constructor.name, ': ffmpeg processing finished !');
		this.command = null;
	}

	onError (err) {
		this.log( this.constructor.name, 'error occurred: ' + err.message);
		if (this.constructor.name === 'JpegsFromMp4File') {
			this.log(this.mp4File);
		}
		if (this.constructor.name === 'PcmListener') {
			this.log(this.loopFile);
		}
		this.command = null;
	}

	stop() {
		this.command && this.command.kill('SIGKILL');
	}
}

class JpegsFromFFmpegBase extends ChunksFromFFmpegBase
{
	constructor( config, jpegsCallback ) 
	{
		let extractor = new MjpegStreamToJpegs( config, jpegsCallback );
		super( config, function(chunk) {
			extractor.checkpoint(chunk);
		});
	}
}

class PcmListener extends ChunksFromFFmpegBase
{
	constructor( config, pcmCallback, endCallback ) 
	{
		super(config, pcmCallback);
		this.endCallback = endCallback || this.onFFmepgEnd.bind(this) ;
		this.errCallback = endCallback || this.onError.bind(this) ;
	}

	start( callback ) 
	{
		this.loopFile = '/tmp/jsmpeg/loop-' + uuidv1() + '.pcm';
		mkfifoSync( this.loopFile, parseInt('0644', 8) );

		callback = callback || this.onFFmpegStart.bind(this);
		let inputOptions = this.config.inputOptions? this.config.inputOptions : [
			'-f s16le'
		];
		let outputOptions = this.config.outputOptions? this.config.outputOptions : [ 
			'-f s16le',
			'-c:a copy',
			'-fflags nobuffer'
		];

		this.command = ffmpeg()
			.input( this.loopFile )
			.inputOptions( inputOptions )
			.output( this.output )
			.outputOptions( outputOptions )
			.on('start', callback)
			.on('error', this.errCallback)
			.on('end', this.endCallback);

		this.command.run();
		return this.loopFile;
	}

	stop() {
		ChunksFromFFmpegBase.prototype.stop.call(this);
		setTimeout( ()=>{
			fs.unlinkSync( this.loopFile );
		}, 1000);
	}
}

class JpegsPcmFromWeb
{
	constructor( config, urlObj, mjpegCallback, pcmCallback,
		 endCallback, errCallback, pcmEndCallback, pcmErrCallback ) 
	{
		this.config = config;
		this.oriUrl = urlObj.oriUrl;
		this.videoUrl = urlObj.videoUrl;
		this.audioUrl = urlObj.audioUrl;
		this.mjpegCallback = mjpegCallback;
		this.pcmCallback = pcmCallback;

		this.endCallback = endCallback || this.onFFmepgEnd;
		this.errCallback = errCallback || this.onError;
		this.pcmEndCallback = pcmEndCallback || this.onFFmepgEnd;
		this.pcmErrCallback = pcmErrCallback || this.onError;
	}

	start( callback ) 
	{
		this.videoCmd = new JpegsFromWebCamera(this.config, this.videoUrl, 
			this.mjpegCallback, 
			(stdout, stderr)=>{
				this.endCallback(stdout, stderr);
				this.videoCmd.command=null;
			},
			(err, stdout, stderr)=>{
				this.errCallback(err, stdout, stderr);
				this.videoCmd.command=null;
			}
		);
		this.videoCmd.start( callback );

		if ( this.audioUrl ) {
			this.audioCmd = new PcmFromWeb( this.config, this.audioUrl, 
				this.pcmCallback,
				(stdout, stderr)=>{
					this.pcmEndCallback(stdout, stderr);
					this.audioCmd.command=null
				},
				(err, stdout, stderr)=>{
					this.pcmErrCallback(err, stdout, stderr);
					this.audioCmd.command=null
				}
			);
			this.audioCmd.start(this.onFFmpegStart.bind(this.audioCmd));
		}
	}

	stop() 
	{
		this.videoCmd && this.videoCmd.stop();
		this.audioCmd && this.audioCmd.stop();
	}

	onFFmpegStart( cmdline ) {
		console.log( this.constructor.name, cmdline);
	}

	onFFmepgEnd () {
		console.log( this.constructor.name, ': ffmpeg processing finished !');
	}

	onError (err) {
		console.log( this.constructor.name, 'error occurred: ' + err.message);
	}
}

class JpegsPcmFromFile extends JpegsFromFFmpegBase
{
	constructor( config, mediaFile, mjpegCallback, pcmCallback, endCallback ) 
	{
		super(config, mjpegCallback);
		this.pcmCallback= pcmCallback;
		this.mediaFile= mediaFile;
		this.endCallback = endCallback || this.onFFmepgEnd.bind(this) ;
		this.errCallback = endCallback || this.onError.bind(this) ;
	}

	start( callback ) 
	{
		callback = callback || this.onFFmpegStart.bind(this);

		ffprobe( this.mediaFile, (err, probeData) => {
			if (err) return;

			let hasVideo = false;
			let hasAudio = false;
			let outputIsUsed = false;
			let mapVideo = '-map 0:V:0';
			let mapAudio = '-map 0:a:0';

			/*
			probeData.streams.forEach( (stream,index) => {
				if ( stream.codec_type === 'video' ) {
					mapVideo = mapVideo || '-map 0:'+index;
					hasVideo = true;
					return;
				} 

				if ( stream.codec_type === 'audio' ) {
					mapAudio = mapAudio || '-map 0:'+index;
					hasAudio = true;
				}
			});
			*/

			// handle input

			let inputOptions = this.config.inputOptions || [];
			this.command = ffmpeg()
				.input( this.mediaFile )
				.native()
				.inputOptions( inputOptions );

			// handle video output 
			
			if ( hasVideo ) {
				this.command.output( this.output );

				let outputVideoOptions = this.config.outputVideoOptions || [ 
					'-map 0:V:0',
					'-f mjpeg', 
					'-c:v mjpeg'
				];
				this.command.outputOptions( outputVideoOptions );

				let filters = this.config.filter || [
					'scale=w=1280:h=720:force_original_aspect_ratio=1', 
					'pad=1280:720:(ow-iw)/2:(oh-ih)/2'
				];

				filters = [
					'scale=w=1280:h=720:force_original_aspect_ratio=1', 
					'pad=1280:720:(ow-iw)/2:(oh-ih)/2'
				];


				if (filters.length > 0) {
					this.command.videoFilters( filters);
				}

				outputIsUsed = true;
			}

			// handle audio output

			if ( hasAudio ) {
				if ( outputIsUsed ) {
					this.pcmListen = new PcmListener(this.config, this.pcmCallback);
					let loopfifo = this.pcmListen.start();
					this.command.output( loopfifo );
				} else {
					this.output.on('data', this.pcmCallback);
					this.command.output( this.output );
				}

				let outputAudioOptions = this.config.outputAudioOptions || [ 
					'-map 0:a:0',
					'-f s16le',
					'-c:a pcm_s16le',
					'-ar 44100', '-ac 2', 
					'-fflags nobuffer',
				];

				this.command.outputOptions( outputAudioOptions );
			}

			this.command.on('start', callback)
				.on('error', this.errCallback)
				.on('end', this.endCallback)
				.run();
		});

		return this;
	}

	stop() {
		ChunksFromFFmpegBase.prototype.stop.call(this);
		if (this.pcmListen) {
			this.pcmListen.stop();
		}
	}
}

class Mp3Listener extends ChunksFromFFmpegBase
{
	constructor( config, mp3Callback, endCallback ) 
	{
		super(config, mp3Callback);
		this.endCallback = endCallback || this.onFFmepgEnd.bind(this) ;
		this.errCallback = endCallback || this.onError.bind(this) ;
	}

	start( callback ) 
	{
		this.loopFile = '/tmp/jsmpeg/loop-' + uuidv1() + '.mp3';
		mkfifoSync( this.loopFile, parseInt('0644', 8) );

		callback = callback || this.onFFmpegStart.bind(this);
		let inputOptions = this.config.inputOptions? this.config.inputOptions : [
			'-f mp3'
		];
		let outputOptions = this.config.outputOptions? this.config.outputOptions : [ 
			'-f mp3', 
			'-c:a copy', 
			'-fflags nobuffer'
		];

		this.command = ffmpeg()
			.input( this.loopFile )
			.inputOptions( inputOptions )
			.output( this.output )
			.outputOptions( outputOptions )
			.on('start', callback)
			.on('error', this.errCallback)
			.on('end', this.endCallback);

		this.command.run();
		return this.loopFile;
	}

	stop() {
		ChunksFromFFmpegBase.prototype.stop.call(this);
		setTimeout( ()=>{
			fs.unlinkSync( this.loopFile );
		}, 1000);
	}
}

class JpegsMp3FromFile extends JpegsFromFFmpegBase
{
	constructor( config, mp4File, mjpegCallback, mp3Callback, endCallback ) 
	{
		super(config, mjpegCallback);
		this.mp3Callback = mp3Callback;
		this.mp4File= mp4File;
		this.endCallback = endCallback || this.onFFmepgEnd.bind(this) ;
		this.errCallback = endCallback || this.onError.bind(this) ;
	}

	start( callback ) 
	{
		this.mp3Listen = new Mp3Listener(this.config, this.mp3Callback, this.onFFmepgEnd.bind(this));
		let loopfifo = this.mp3Listen.start();

		let inputOptions = this.config.inputOptions || [];
		let outputAudioOptions = this.config.outputAudioOptions || [ 
			'-map 0:a',
			'-f mp3', 
			'-c:a libmp3lame', 
			'-ar 44100', '-ab 128k', '-ac 2', 
			'-fflags nobuffer',
			'-y'
		];

		let outputVideoOptions = this.config.outputVideoOptions || [ 
			'-map 0:v',
			'-f mjpeg', 
			'-c:v mjpeg'
		];

		let filters = this.config.filter || [
			'crop=iw:9/16*iw:0:(ih-oh)/2'
		];

		this.command = ffmpeg()
			.input( this.mp4File )
			.native()
			.inputOptions( inputOptions )
			.output( this.output )
			.outputOptions( outputVideoOptions )
			.videoFilters( filters )
			.output( loopfifo )
			.outputOptions( outputAudioOptions )
			.on('start', callback)
			.on('error', this.errCallback)
			.on('end', this.endCallback);

		this.command.run();
		return this;
	}

	stop() {
		ChunksFromFFmpegBase.prototype.stop.call(this);
		if (this.mp3Listen) {
			this.mp3Listen.stop();
		}
	}
}

class Mp3FromFile extends ChunksFromFFmpegBase
{
	constructor( config, mp4File, chunksCallback, endCallback ) 
	{
		super(config, chunksCallback);
		this.mp4File = mp4File;
		this.endCallback = endCallback || this.onFFmepgEnd.bind(this) ;
		this.errCallback = endCallback || this.onError.bind(this) ;
	}

	start( callback ) 
	{
		callback = callback || this.onFFmpegStart.bind(this);
		let inputOptions = this.config.inputOptions? this.config.inputOptions : [];
		let outputOptions = this.config.outputOptions? this.config.outputOptions : [ 
			'-map 0:a',
			'-f mp3', 
			'-acodec libmp3lame', 
			'-ar 44100', '-ab 128k', '-ac 2', 
			'-fflags nobuffer'
		];

		this.command = ffmpeg()
			.input( this.mp4File)
			.native()
			.inputOptions( inputOptions )
			.output( this.output )
			.outputOptions( outputOptions )
			.on('start', callback)
			.on('error', this.errCallback)
			.on('end', this.endCallback);

		this.command.run();
		return this;
	}

}

class PcmFromWeb extends ChunksFromFFmpegBase
{
	constructor( config, inputMedia, chunksCallback, endCallback, errCallback ) 
	{
		super(config, chunksCallback);
		this.inputMedia = inputMedia;
		this.endCallback = endCallback || this.onFFmepgEnd.bind(this) ;
		this.errCallback = errCallback || this.onError.bind(this) ;
	}

	start( callback ) 
	{
		callback = callback || this.onFFmpegStart.bind(this);
		let inputOptions = this.config.inputAudioOptions? this.config.inputAudioOptions: [];
		let outputOptions = this.config.outputAudioOptions? this.config.outputAudioOptions : [ 
			'-f s16le',
			'-acodec pcm_s16le',
			'-ar 44100', '-ac 2', 
			'-fflags nobuffer'
		];

		this.command = ffmpeg()
			.input( this.inputMedia)
			.inputOptions( inputOptions )
			.output( this.output )
			.outputOptions( outputOptions )
			.on('start', callback)
			.on('error', this.errCallback)
			.on('end', this.endCallback);

		this.command.run();
		return this;
	}

}

class PcmFromFile extends ChunksFromFFmpegBase
{
	constructor( config, inputMedia, chunksCallback, endCallback, errCallback ) 
	{
		super(config, chunksCallback);
		this.inputMedia = inputMedia;
		this.endCallback = endCallback || this.onFFmepgEnd.bind(this) ;
		this.errCallback = errCallback || this.onError.bind(this) ;
	}

	start( callback ) 
	{
		callback = callback || this.onFFmpegStart.bind(this);
		let inputOptions = this.config.inputAudioOptions? this.config.inputAudioOptions: [];
		let outputOptions = this.config.outputAudioOptions? this.config.outputAudioOptions : [ 
			'-map 0:a',
			'-f s16le',
			'-acodec pcm_s16le',
			'-ar 44100', '-ac 2', 
			'-fflags nobuffer'
		];

		this.command = ffmpeg()
			.input( this.inputMedia)
			.native()
			.inputOptions( inputOptions )
			.output( this.output )
			.outputOptions( outputOptions )
			.on('start', callback)
			.on('error', this.errCallback)
			.on('end', this.endCallback);

		this.command.run();
		return this;
	}

}



class JpegsFromMp4File extends JpegsFromFFmpegBase
{
	constructor( config, mp4File, jpegsCallback, endCallback ) 
	{
		super(config, jpegsCallback);
		this.mp4File = mp4File;
		this.endCallback = endCallback || this.onFFmepgEnd.bind(this) ;
		this.errCallback = endCallback || this.onError.bind(this) ;
	}

	start( callback ) 
	{
		callback = callback || this.onFFmpegStart.bind(this);
		let inputOptions = this.config.inputOptions? this.config.inputOptions : [];

		this.command = ffmpeg()
			.input( this.mp4File )
			.native()
			.inputOptions( inputOptions )
			.output( this.output )
			.outputOptions([ '-f mjpeg', '-c:v mjpeg' ])
			.videoFilters( this.config.filter )
			.on('start', callback)
			.on('error', this.errCallback)
			.on('end', this.endCallback);

		this.command.run();
		return this;
	}
}

class JpegsFromWebCamera extends JpegsFromFFmpegBase
{
	constructor( config, url, jpegsCallback, endCallback, errCallback ) 
	{
		super(config, jpegsCallback);
		this.url = url;
		this.endCallback = endCallback || this.onFFmepgEnd.bind(this) ;
		this.errCallback = errCallback || this.onError.bind(this) ;
	}

	start (callback) 
	{
		callback = callback || this.onFFmpegStart.bind(this);
		let inputOptions = this.config.inputOptions? this.config.inputOptions : [];

		this.command = ffmpeg()
			.input(this.url)
			.inputOptions( inputOptions )
			.output(this.output)
			.outputOptions(['-f mjpeg', '-c:v mjpeg'])
			.videoFilters( this.config.filter )
			.on('start', callback)
			.on('error', this.errCallback)
			.on('end', this.endCallback);
		this.command.run();
		return this;
	}
}

class JpegsFromUsbCamera extends JpegsFromFFmpegBase
{
	constructor( config, devPath, jpegsCallback, endCallback, errCallback ) 
	{
		super( config, jpegsCallback );
		this.devPath = devPath;
		this.command = null;
		this.endCallback = endCallback || this.onFFmepgEnd.bind(this) ;
		this.errCallback = errCallback || this.onError.bind(this) ;
	}

	start( callback ) 
	{
		callback = callback || this.onFFmpegStart.bind(this);
	
		let inputOptions = this.config.inputOptions? this.config.inputOptions : ['-f v4l2'];
		if (inputOptions.indexOf('-f v4l2') === -1) {
			inputOptions.push( '-f v4l2' );
		}

		this.command = ffmpeg()
			.input(this.devPath)
			.inputOptions( inputOptions )
			.output(this.output)
			.outputOptions(['-f mjpeg', '-c:v mjpeg'])
			.videoFilters( this.config.filter )
			.on('start', callback)
			.on('error', this.errCallback)
			.on('end', this.endCallback);

		this.command.run();
		return this;
	}
}

class Mpeg1tsFromJpegs extends ChunksFromFFmpegBase
{
	constructor( config, mpegtsCallback, qscale=8, endCallback ) 
	{
		super( config, mpegtsCallback );
		this.qscale = qscale;
		
		this.input = new PassThroughStream();
		this.input.on('error', this.onError.bind(this));
		this.endCallback = endCallback || this.onFFmepgEnd.bind(this) ;
		this.errCallback = endCallback || this.onError.bind(this) ;
	}

	write( chunk ) {
		this.input.write(chunk);	
	}

	start( callback ) 
	{
		callback = callback || this.onFFmpegStart.bind(this);
		this.command = ffmpeg()
			.input(this.input)
			.inputFormat('mjpeg')
			.output(this.output)
			.outputOptions(['-f mpegts', '-c:v mpeg1video', '-q:v '+ this.qscale, '-bf 0'])
			.outputFps(30)
			.on('start', callback)
			.on('error', this.errCallback)
			.on('end', this.endCallback);

		this.command.run();
		return this;
	}
}

class JpegsToLiveRtmp
{
	constructor( config, endCallback ) 
	{
		this.config = config;
		this.input = new PassThroughStream();
		this.input.on('error', endCallback);
		this.endCallback = endCallback;
	}

	write( chunk ) {
		this.input.write(chunk);	
	}

	onError( error, stdout, stderr ) 
	{
		console.debug(stdout);
		console.debug(stderr);
	}

	onEnd( error ) 
	{
		this.endCallback( error );
	}

	onStart( cmdline ) 
	{
		console.log( this.constructor.name, cmdline);
	}

	start( startCallback ) 
	{
		startCallback = startCallback || this.onStart.bind(this); 

		this.command = ffmpeg();
		this.command.input(this.input);
		this.command.inputFormat('mjpeg');

		this.config.inputs.forEach( (config) => {
			if (config.active !== undefined) {
				if (config.active !== true) {
					return;
				}
			}

			this.command.input( config.inputFrom );
			this.command.inputOptions( config.options );
		});

		this.config.outputs.forEach( (config) => {
			if (config.active !== undefined) {
				if (config.active !== true) {
					return;
				}
			}

			this.command.output( config.outputTo );
			this.command.outputOptions( config.options );
		});

		this.command.on('start', startCallback )
		this.command.on('error', this.onError.bind(this) );
		this.command.on('end', this.onEnd.bind(this) );
		this.command.run();
		return this;
	}
}

class LocalToLiveRtmp
{
	constructor( config, endCallback ) 
	{
		this.config = config;
		this.endCallback = endCallback;
	}

	onError( error, stdout, stderr ) 
	{
		console.log(stdout);
		console.log(stderr);
		this.endCallback(error);
	}

	onEnd( error ) 
	{
		this.endCallback( error );
	}

	onStart( cmdline ) 
	{
		console.log( this.constructor.name, cmdline);
	}

	start( startCallback ) 
	{
		startCallback = startCallback || this.onStart.bind(this); 

		this.command = ffmpeg();
		this.config.inputs.forEach((ipt) => {
			if(ipt.active) {
				this.command.input( ipt.src );
				this.command.inputOptions( ipt.options );
			}
		})

		this.command.output( this.config.output.outputTo );
		this.command.outputOptions( this.config.output.options );

		this.command.on('start', startCallback )
		this.command.on('error', this.onError.bind(this) );
		this.command.on('end', this.onEnd.bind(this) );
		this.command.run();
		return this;
	}

	stop() {
		this.command && this.command.kill('SIGKILL');
	}
}

module.exports = {
	Mpeg1tsFromJpegs,
	JpegsToLiveRtmp, LocalToLiveRtmp,
	JpegsFromWebCamera, JpegsFromUsbCamera, JpegsFromMp4File,
	Mp3FromFile, JpegsMp3FromFile,
	PcmFromFile, PcmFromWeb, JpegsPcmFromFile,
	JpegsPcmFromWeb
};
