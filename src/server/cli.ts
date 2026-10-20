import {startServer} from './index.js';
const token = process.env.LOBBY_DOCS_TOKEN;
if (!token || token.length < 32) throw new Error('Set LOBBY_DOCS_TOKEN to a random secret of at least 32 characters');
const server = await startServer({token, port: Number(process.env.LOBBY_DOCS_PORT ?? 4789)});
console.log(`Forum local authority listening at ${server.url}`);
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {void server.close().then(() => process.exit());});
