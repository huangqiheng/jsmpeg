
const {genPlaylist} = require('./module-common.js');
const {JpegsPcmFromFile} = require('./module-transcode.js');

module.exports = class LocalMp4Source
{
	static get name() { 
		return 'localMp4'; 
	}

	constructor( env ) 
	{
		this.sourceName = LocalMp4Source.name;
		this.feedImage = env.get('feedImage');
		this.feedPCM = env.get('feedPCM');
		this.config = env.get('configs').get('source.' + this.sourceName);
		this.size = this.config.size;
		this.active = false;
		this.onlineList = {};
		this.disableList = [];
		this.file2Play = []
		this.nowLoop = this.config.loop;
		this.nowOrder = this.config.order;

		if (this.config.autoStartIndex !== -1) {
			for (var i=0; i<this.config.src.length; i++) {
				if (i !== this.config.autoStartIndex) {
					this.disableList.push( this.config.src[i] );
				}
			}
		}

		this.defaultCmdObj = {
			disableList: this.disableList,
			order: this.nowOrder,
			loop: this.nowLoop
		};

		if (this.config.autoStart === true) {
			this.start();
		} else {
			genPlaylist( this.config.src, [], this.nowOrder, ollist=>{
				this.onlineList	= ollist;
			});
		}
	}

	start( cmdObj, callback )
	{
		if (cmdObj === undefined) {
			cmdObj = this.defaultCmdObj;
		}

		this.active = true;

		if (cmdObj.internalCall !== true) {
			this.file2Play.length = 0;
			this.source && this.source.stop();
		}

		if (this.file2Play.length === 0) {
			genPlaylist( this.config.src, cmdObj.disableList, cmdObj.order, list => {
				this.file2Play = list;

				if (this.file2Play.length === 0) {
					console.log('FATAL ERROR. the input source mp4 list is empty.');
					return;
				}

				setImmediate( ()=> {
					cmdObj.internalCall = true;
					this.active && this.start( cmdObj );
				});
			});

			this.disableList = cmdObj.disableList;
			this.nowLoop = cmdObj.loop;
			this.nowOrder = cmdObj.order;
			return;
		}

		let mp4File = this.file2Play.shift();
		do {
			if (mp4File) break;

			if (cmdObj.loop !== 'yes') {
				this.stop();
				return;
			}

			setImmediate( function(){
				this.active && this.start( cmdObj );
			}.bind(this));
			return;
		} while(false);

		console.log('playing: ', mp4File);
		this.source = new JpegsPcmFromFile( this.config, mp4File, 
			this.feedImageProxy.bind(this),
			this.feedPcmProxy.bind(this),
			(err, sout, serr)=>{
				if(err) {
					console.log(sout);
					console.log(serr);
				}
				setImmediate( ()=>{
					cmdObj.internalCall = true;
					this.active && this.start( cmdObj );
				});
		}).start( callback );
	}

	feedImageProxy( jpeg ) 
	{
		this.active && this.feedImage( jpeg );
	}

	feedPcmProxy( chunk ) 
	{
		this.active && this.feedPCM( chunk );
	}

	list()
	{
		return {
			name: this.sourceName,
			active: this.active,
			caption: this.config.caption,
			loop: this.nowLoop,
			order: this.nowOrder,
			disableList: this.disableList,
			onlineList: this.onlineList
		}
	}

	pause ()
	{
		this.active = false;
	}

	resume ()
	{
		this.active = true;
	}

	stop ()
	{
		this.active = false;
		this.source && this.source.stop();
	}

	advBoxToggle() 
	{ 
		console.log(this.name, "advBox toggled, no effect on this source.");
	}

};
