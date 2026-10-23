'use strict';
// Local development entry point. Deployment and certificate provisioning are intentionally separate.
const fs = require('node:fs');
const { createBroker } = require('./broker.cjs');
async function main() {
  const { RELAY_REMOTE_TLS_KEY, RELAY_REMOTE_TLS_CERT, RELAY_REMOTE_SERVICE_KEY } = process.env;
  if (!RELAY_REMOTE_TLS_KEY || !RELAY_REMOTE_TLS_CERT || !RELAY_REMOTE_SERVICE_KEY) throw new Error('请设置 RELAY_REMOTE_TLS_KEY、RELAY_REMOTE_TLS_CERT 和 RELAY_REMOTE_SERVICE_KEY。服务不会自行申请证书或部署。');
  const port = Number(process.env.RELAY_REMOTE_PORT || 9443); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('中继监听端口无效。');
  const broker = await createBroker({ key: fs.readFileSync(RELAY_REMOTE_TLS_KEY), cert: fs.readFileSync(RELAY_REMOTE_TLS_CERT), serviceKey: RELAY_REMOTE_SERVICE_KEY, host: '127.0.0.1', port });
  console.log('远程中继本地验证服务已启动：127.0.0.1:' + broker.port + '；未部署公网服务。');
  let closing = false; const stop = async () => { if (closing) return; closing = true; await broker.close(); }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
