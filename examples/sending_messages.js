import Peer from '../src/esm.js';

(async () => {
    const peer = new Peer();

    await peer.start();

    // this must be called to ensure replies are received
    await peer.sub();

    // let's publish the message! this wil
    await peer.pub('yourPeerCid', 'test', 'hello world', (err, msg) => {
        console.log('reply: ' + msg);
    });
})();