export type Identity={expiresAt?:number;userId:string;name:string;organizationId:string;workspace:string};
export type AuthConfig={url:string};
export function secureOrigin(value:string){
  const url=new URL(value);
  if(url.origin!==value.replace(/\/$/,'')||url.username||url.password||(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname))))throw new Error('invalid_auth_origin');
  return url.origin;
}
/** Resolve the account and current membership at the issuer, never from request data. */
export function authAuthority(config:AuthConfig,fetcher:typeof fetch=fetch){
  const origin=secureOrigin(config.url);
  return async(token:string):Promise<Identity>=>{
    if(!token||token.length>4096||/[\r\n]/.test(token))throw new Error('auth_required');
    async function get(path:string){
      const response=await fetcher(new URL('/api/auth/'+path,origin),{headers:{authorization:`Bearer ${token}`},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw new Error(response.status>=500?'auth_unavailable':'auth_required');
      return response.json();
    }
    const session=await get('get-session?disableCookieCache=true'),user=session?.user,organizationId=session?.session?.activeOrganizationId;
    if(typeof user?.id!=='string'||!user.id||user.banned||typeof organizationId!=='string'||!organizationId)throw new Error('auth_required');
    const member=await get('organization/get-active-member');
    if(member?.userId!==user.id||member.organizationId!==organizationId||typeof member.role!=='string'||!member.role)throw new Error('auth_required');
    return {userId:user.id,organizationId,name:(typeof user.name==='string'&&user.name.trim()?user.name:'Member').slice(0,120),workspace:organizationId};
  };
}
