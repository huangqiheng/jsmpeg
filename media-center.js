
const argv = require('minimist')(process.argv.slice(2));
const WebSocketHub = require('./container-wsocket.js'); 

let allConfigs = require('config');

if (argv.index === undefined) {
	let configs = allConfigs.get('centerNodes');
	let [ index, activeCount ] = WebSocketHub.getFirstActive( configs );

	if (activeCount === 0) {
		console.log( 'The configs has no active item' );
		return;
	}

	if (activeCount > 1) {
		WebSocketHub.centerSupervisor( allConfigs );
		return;
	}

	argv.index = index;
}

var wshub = new WebSocketHub( allConfigs );
wshub.addSourcer( require('./source-webCamera.js') );
wshub.addSourcer( require('./source-usbCamera.js') );
wshub.addSourcer( require('./source-localMp4.js') );
wshub.addHandler( require('./handler-mpeg1.js') );
wshub.addHandler( require('./handler-mjpeg.js') );
wshub.addHandler( require('./handler-manager.js') );
wshub.runCenter( argv.index );
