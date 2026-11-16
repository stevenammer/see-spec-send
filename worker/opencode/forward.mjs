// Container-side seam: the agent talks to http://127.0.0.1:8787, which is only
// a pipe to the mounted gateway socket. The container has no other network.
import net from 'node:net';
const socket = process.env.SSS_GATEWAY_SOCKET || '/gateway/gateway.sock';
net.createServer(client => {
  const upstream = net.connect(socket);
  client.pipe(upstream).pipe(client);
  const end = () => { client.destroy(); upstream.destroy(); };
  client.on('error', end); upstream.on('error', end);
}).listen(8787, '127.0.0.1');
