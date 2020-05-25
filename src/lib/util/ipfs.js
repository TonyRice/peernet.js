export const DEFAULT_BOOTSTRAP = [
    "/dns4/arthur.bootstrap.peernet.dev/tcp/4001/p2p/QmaM3FbA8amt6WGeN9Zq7zz8EmGxwdcAeHtcAUx3SoxkWF",
    "/dns4/john.bootstrap.peernet.dev/tcp/4001/p2p/QmcSJKAznvnnVKyWbRhzJDTqLnp1LuNXS8ch9SwcR713bX",
    "/ip6/2607:9000:0:19:216:3cff:fe80:9c47/tcp/4001/p2p/QmaM3FbA8amt6WGeN9Zq7zz8EmGxwdcAeHtcAUx3SoxkWF",
    "/ip6/2607:9000:0:28:216:3cff:fe80:9c47/tcp/4001/p2p/QmaM3FbA8amt6WGeN9Zq7zz8EmGxwdcAeHtcAUx3SoxkWF",
    '/dns4/nyc-1.bootstrap.libp2p.io/tcp/4001/p2p/QmSoLueR4xBeUbY9WZ9xGUUxunbKWcrNFTDAadQJmocnWm',
    '/dns4/nyc-2.bootstrap.libp2p.io/tcp/4001/p2p/QmSoLV4Bbm51jM9C4gDYZQ9Cy3U6aXMJDAbzgu2fzaDs64',
    '/dns4/ams-1.bootstrap.libp2p.io/tcp/4001/p2p/QmSoLer265NRgSp2LA3dPaeykiS1J6DifTC88f5uVQKNAd',
    '/dns4/lon-1.bootstrap.libp2p.io/tcp/4001/p2p/QmSoLMeWqB7YGVLJN3pNLQpmmEk35v6wYtsMGLzSr5QBU3',
    '/dns4/sfo-3.bootstrap.libp2p.io/tcp/4001/p2p/QmSoLPppuBtQSGwKDZT2M73ULpjvfd3aZ6ha4oFGL1KrGM',
    '/dns4/sgp-1.bootstrap.libp2p.io/tcp/4001/p2p/QmSoLSafTMBsPKadTEgaXctDQVcqN88CNLHXMkTNwMKPnu',
    '/dns4/node0.preload.ipfs.io/tcp/4001/p2p/QmZMxNdpMkewiVZLMRxaNxUeZpDUb34pWjZ1kZvsd16Zic',
    '/dns4/node1.preload.ipfs.io/tcp/4001/p2p/Qmbut9Ywz9YEDrz8ySBSgWyJk41Uvm2QJPhwDJzJyGFsD6',
];

export const DEFAULT_BOOTSTRAP_BROWSER = [
    "/dns4/arthur.bootstrap.peernet.dev/tcp/4002/wss/p2p/QmaM3FbA8amt6WGeN9Zq7zz8EmGxwdcAeHtcAUx3SoxkWF",
    "/dns4/john.bootstrap.peernet.dev/tcp/4002/wss/p2p/QmcSJKAznvnnVKyWbRhzJDTqLnp1LuNXS8ch9SwcR713bX",
    '/dns4/ams-1.bootstrap.libp2p.io/tcp/443/wss/ipfs/QmSoLer265NRgSp2LA3dPaeykiS1J6DifTC88f5uVQKNAd',
    '/dns4/lon-1.bootstrap.libp2p.io/tcp/443/wss/ipfs/QmSoLMeWqB7YGVLJN3pNLQpmmEk35v6wYtsMGLzSr5QBU3',
    '/dns4/sfo-3.bootstrap.libp2p.io/tcp/443/wss/ipfs/QmSoLPppuBtQSGwKDZT2M73ULpjvfd3aZ6ha4oFGL1KrGM',
    '/dns4/sgp-1.bootstrap.libp2p.io/tcp/443/wss/ipfs/QmSoLSafTMBsPKadTEgaXctDQVcqN88CNLHXMkTNwMKPnu',
    '/dns4/nyc-1.bootstrap.libp2p.io/tcp/443/wss/ipfs/QmSoLueR4xBeUbY9WZ9xGUUxunbKWcrNFTDAadQJmocnWm',
    '/dns4/nyc-2.bootstrap.libp2p.io/tcp/443/wss/ipfs/QmSoLV4Bbm51jM9C4gDYZQ9Cy3U6aXMJDAbzgu2fzaDs64',
    '/dns4/node0.preload.ipfs.io/tcp/443/wss/ipfs/QmZMxNdpMkewiVZLMRxaNxUeZpDUb34pWjZ1kZvsd16Zic',
    '/dns4/node1.preload.ipfs.io/tcp/443/wss/ipfs/Qmbut9Ywz9YEDrz8ySBSgWyJk41Uvm2QJPhwDJzJyGFsD6'
];

export async function cat(node , hash, timeout) {
    timeout = timeout ? timeout : '60s';

    try {
        const stream = node.cat(hash, {'timeout': timeout})
        let data = ''
        for await (const chunk of stream) {
            data += chunk.toString()
        }
        return data;
    } catch (err) {
    }
    return null;
}

export async function add(node, data) {
    try {
        for await (const {cid} of node.add(data)) {
            if(cid) {
                return cid.toString();
            }
        }
    } catch (err) {
        console.error(err)
    }
    return null;
}

export async function pin(node, cid) {
    return await node.pin.add(cid);
}

export async function unpin(node, cid) {
    return await node.pin.rm(cid);
}

export async function connect(node, peer) {
    await node.swarm.connect(peer);
}

export async function disconnect(node, peer) {
    await node.swarm.disconnect(peer);
}

