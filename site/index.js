const links=[...document.querySelectorAll('.download-link')],status=document.getElementById('release-status');
async function release(){
  try{
    const response=await fetch('release.json',{cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('unavailable');
    const value=await response.json();
    if(value.product==='forum'&&value.available===false){status.textContent='The Mac download is not available yet.';return;}
    const url=new URL(value.url,location.href);
    if(value.product!=='forum'||value.platform!=='darwin'||value.arch!=='arm64'||typeof value.version!=='string'||!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version)||url.protocol!=='https:'||!Number.isSafeInteger(value.sizeBytes)||value.sizeBytes<1||!/^sha256:[a-f0-9]{64}$/.test(value.checksum))throw new Error('invalid release');
    for(const link of links){link.href=url.href;link.removeAttribute('aria-disabled');}
    status.textContent=`Version ${value.version} for macOS on Apple Silicon.`;
  }catch{for(const link of links){link.removeAttribute('href');link.setAttribute('aria-disabled','true');}status.textContent='The Mac download could not be loaded. Please try again shortly.';}
}
void release();
