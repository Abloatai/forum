// Native packaging follows Coding. Signing profiles remain local to the publisher.
const {execFileSync}=require('node:child_process');
const {rmSync}=require('node:fs');
module.exports={
  packagerConfig:{name:'Forum',executableName:'forum',asar:true,icon:'./resources/icon',appBundleId:'com.ablo.forum',appCategoryType:'public.app-category.productivity',ignore:p=>p!==''&&p!=='/package.json'&&!p.startsWith('/dist'),...(process.env.FORUM_SIGN_IDENTITY?{osxSign:{identity:process.env.FORUM_SIGN_IDENTITY,continueOnError:false}}:{})},
  makers:[{name:'@electron-forge/maker-zip',platforms:['darwin']}],
  hooks:{postPackage:async(_config,options)=>{
    if(options.platform!=='darwin'||!process.env.FORUM_NOTARY_PROFILE)return;
    for(const output of options.outputPaths){
      const app=`${output}/Forum.app`,archive=`${app}.notarize.zip`;
      execFileSync('codesign',['--verify','--deep','--strict',app],{stdio:'inherit'});
      execFileSync('ditto',['-c','-k','--keepParent',app,archive],{stdio:'inherit'});
      try{execFileSync('xcrun',['notarytool','submit',archive,'--keychain-profile',process.env.FORUM_NOTARY_PROFILE,'--wait'],{stdio:'inherit'});}finally{rmSync(archive,{force:true});}
      execFileSync('xcrun',['stapler','staple',app],{stdio:'inherit'});
    }
  }},
};
