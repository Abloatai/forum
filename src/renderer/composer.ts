import {composerToken, insertReference, referenceRanges} from './matching.js';
type Model={id:string;name:string;isDefault:boolean};
type Document = {id: string; title: string};
type Choice = {label: string; detail: string; value: string; disabled?: boolean};

// Coding's caret/menu interaction pattern, adapted to real local document and
// session data. References are text only: no notifications or cross-doc reads.
export function composerMenu(input: HTMLTextAreaElement, list: HTMLElement, loadDocuments: () => Promise<Document[]>, notice: (text: string) => void) {
  let models:Model[]=[],model:string|undefined,verified=false;
  let agent: string | null = null, members: string[] = [], documents: Document[] = [];
  let recipient: 'agent' | 'team' = 'team', initialized = false;
  let selected = 0, options: Choice[] = [], signature = '', dismissed = '', composing = false;
  let documentMenu = false, loading = false, loadError = false, generation = 0;
  let token: ReturnType<typeof composerToken> = null;
  const placeholder = () => {
    input.placeholder = recipient === 'agent' ? agent ?? 'Agent not configured' : 'Message';
  };
  function close() {
    list.hidden = true; list.replaceChildren(); options = [];
    input.removeAttribute('aria-controls'); input.removeAttribute('aria-activedescendant');
  }
  function highlight() {
    const entries = list.querySelectorAll<HTMLElement>('[role=option]');
    entries.forEach((entry, index) => entry.setAttribute('aria-selected', String(index === selected)));
    if (entries[selected]) {
      input.setAttribute('aria-activedescendant', entries[selected].id);
      entries[selected].scrollIntoView({block: 'nearest'});
    } else input.removeAttribute('aria-activedescendant');
  }
  function choose(index: number) {
    const choice = options[index];
    if (!choice || !token) return;
    if (choice.disabled) {notice('Agent not configured'); return;}
    let caret: number;
    if(token.trigger==='/' && token.query.startsWith('model ')){
      model=choice.value;input.value=input.value.slice(0,token.start)+input.value.slice(token.end);caret=token.start;
    } else if(token.trigger==='/' && choice.value==='model'){
      input.value=input.value.slice(0,token.start)+'/model '+input.value.slice(token.end);caret=token.start+7;input.focus();input.setSelectionRange(caret,caret);render();return;
    } else if (token.trigger === '/') {
      recipient = choice.value as 'agent' | 'team';
      input.value = input.value.slice(0, token.start) + input.value.slice(token.end);
      caret = token.start;
      placeholder();
    } else {
      input.value = insertReference(input.value, token, choice.value);
      caret = token.start + choice.value.length + 1;
    }
    input.focus(); input.setSelectionRange(caret, caret);
    dismissed = `${input.value}:${caret}:${caret}`;
    close();
  }
  function render() {
    const nextSignature = `${input.value}:${input.selectionStart}:${input.selectionEnd}`;
    if (nextSignature !== signature) {selected = 0; signature = nextSignature;}
    token = composerToken(input.value, input.selectionStart);
    const references = [...members.map(name => `@${name}`), ...documents.map(doc => `#${doc.title}`)];
    if (token?.trigger !== '/' && referenceRanges(input.value, references).some(range => range.start <= (token?.start ?? -1) && range.end >= input.selectionStart)) token = null;
    if (!token || input.disabled || composing || input.selectionStart !== input.selectionEnd || document.activeElement !== input || dismissed === signature) {
      documentMenu = false; close(); return;
    }
    if (token.trigger === '#' && !documentMenu) {
      documentMenu = true; loading = true; loadError = false;
      const current = generation;
      void loadDocuments().then(values => {if (current === generation) {documents = values; loading = false; render();}}).catch(() => {if (current === generation) {loading = false; loadError = true; render();}});
    } else if (token.trigger !== '#') documentMenu = false;
    const query = token.query.toLowerCase();
    let label: string, hint: string;
    if(token.trigger==='/' && token.query.startsWith('model ')){
      label='Models';hint=agent==='Scripted test agent'?'Scripted test agent has no model provider':'Available backend models';
      options=models.filter(value=>value.name.toLowerCase().includes(query.slice(6))||value.id.toLowerCase().includes(query.slice(6))).map(value=>({label:value.name,detail:value.id===model?'Selected':value.isDefault?'Default':value.id,value:value.id}));
    } else if (token.trigger === '/') {
      label = 'Commands'; hint = 'Choose who receives your message';
      options = [
        {label: '/agent', detail: agent ?? 'Agent not configured', value: 'agent', disabled: !agent},
        {label: '/team', detail: 'Message this document’s members', value: 'team'},
        {label:'/model',detail:'Choose a backend model',value:'model'},
      ].filter(choice => choice.label.slice(1).startsWith(query));
    } else if (token.trigger === '@') {
      label = 'Session members'; hint = 'Session references only, no notifications';
      options = members.filter(name => name.toLowerCase().includes(query)).map(name => ({label: name, detail: verified?'Workspace member':'Document session, not a verified identity', value: `@${name}`}));
    } else {
      label = 'Documents'; hint = 'References only, document content is not included';
      options = documents.filter(doc => doc.title.toLowerCase().includes(query)).map(doc => ({label: doc.title, detail: doc.id.slice(0, 8), value: `#${doc.title}`}));
    }
    list.hidden = false; list.setAttribute('aria-label', label); list.replaceChildren();
    input.setAttribute('aria-controls', list.id);
    const heading = document.createElement('p'); heading.className = 'composer-menu-hint'; heading.textContent = hint; list.append(heading);
    if (!options.length) {
      const empty = document.createElement('p'); empty.className = 'composer-menu-hint';
      empty.textContent = token.trigger === '#' && loading ? 'Loading documents…' : token.trigger === '#' && loadError ? 'Could not load documents' : 'No matches'; list.append(empty);
    }
    options.forEach((choice, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.tabIndex = -1;
      button.id = `${list.id}-${index}`; button.setAttribute('role', 'option');
      if (choice.disabled) button.setAttribute('aria-disabled', 'true');
      const title = document.createElement('span'); title.textContent = choice.label;
      const detail = document.createElement('small'); detail.textContent = choice.detail;
      button.append(title, detail);
      button.onmousedown = event => event.preventDefault();
      button.onmouseenter = () => {selected = index; highlight();};
      button.onclick = () => choose(index); list.append(button);
    });
    selected = Math.min(selected, Math.max(0, options.length - 1)); highlight();
  }
  input.addEventListener('input', render);
  input.addEventListener('select', render);
  input.addEventListener('click', render);
  input.addEventListener('focus', render);
  input.addEventListener('blur', close);
  input.addEventListener('keyup', event => {if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) render();});
  input.addEventListener('compositionstart', () => {composing = true; close();});
  input.addEventListener('compositionend', () => {composing = false; render();});
  return {
    get model(){return model;},
    get recipient() {return recipient;},
    reset() {generation++; initialized = false; documents = []; members = []; agent = null; documentMenu = false; dismissed = ''; signature = ''; close();},
    update(state: {agent: string | null; members: string[];models?:Model[];verified?:boolean}) {
      models=state.models??[];verified=!!state.verified;if(model&&!models.some(value=>value.id===model))model=undefined;
      agent = state.agent; members = [...new Set(state.members)];
      if (!initialized) {recipient = agent ? 'agent' : 'team'; initialized = true;}
      if (!agent) recipient = 'team';
      placeholder(); render();
    },
    keydown(event: KeyboardEvent) {
      if (event.isComposing || composing) return true;
      if (list.hidden) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % Math.max(options.length, 1); highlight(); return true;
      }
      if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); dismissed = signature; close(); return true;}
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        event.preventDefault(); choose(selected); return true;
      }
      return false;
    },
  };
}
