/** Forward only production Ablo session cookies, as Coding does. */
export function browserSessionCookie(headers:Headers){
  return (headers.get('cookie')??'').split(';').map(value=>value.trim()).filter(value=>{
    const name=value.slice(0,value.indexOf('='));
    return name==='__Secure-better-auth.session_token'||name==='better-auth.session_token';
  }).join('; ');
}
