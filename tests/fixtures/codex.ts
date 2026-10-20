// Already-connected personal account for UI checks unrelated to onboarding.
import {personalCodex} from '../../src/codex/index.js';
export const connectedCodex=personalCodex({
 async read(){return {value:{generation:'sample-connected',auth:'synthetic-auth',view:{email:'sample@example.test',plan:'plus',models:[]}}};},
 async write(){throw new Error('Unexpected Codex write in connected-account fixture');},
});
