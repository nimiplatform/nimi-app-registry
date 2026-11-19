import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import path from 'node:path';
import { loadValidators } from './registry-validation.mjs';
import { admittedClient } from './hosted-products.mjs';
import { validateRemoteClientFacts, expectedSourceRevision } from './remote-client-validation.mjs';

const { values } = parseArgs({ options:{product:{type:'string'},candidate:{type:'string'},review:{type:'string'}} });
if(!values.product || !values.candidate || !values.review)throw Error('Pass --product, --candidate and an explicit maintainer --review JSON file.');
const read = async file=>JSON.parse(await readFile(file,'utf8'));
const optional = async file=>read(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
const product=await read(values.product), candidate=await read(values.candidate), decision=await read(values.review);
if(decision.decision!=='approved' || Object.hasOwn(candidate.source,'review') || Object.hasOwn(candidate.release,'review')) throw Error('Expected a publisher candidate and separate explicit maintainer decision.');
const checks=await loadValidators();
if(!checks.product(product))throw Error('Invalid product record');
const directory=path.resolve('products',product.app_id);
if(path.resolve(values.product)!==path.join(directory,'product.json'))throw Error('Use the product in this Registry checkout.');
const release={...candidate.release,review:decision};
if(!checks.webRelease(release) || release.app_id!==product.app_id || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(release.client_id))throw Error('Invalid release or maintainer review: '+JSON.stringify(checks.webRelease.errors));
if(candidate.source.kind!=='hosted-web' || candidate.source.client_id!==release.client_id || candidate.source.stable_version!==release.version ||
   candidate.source.source_revision!==release.source_revision || !isDeepStrictEqual(candidate.source.app_access,release.app_access) ||
   !isDeepStrictEqual(candidate.source.capability_contract_refs,release.capability_contract_refs))throw Error('Candidate source and release do not agree.');
const target=path.join(directory,'web/releases',release.version+'.json'), sourceFile=path.join(directory,'sources',release.client_id+'.json');
const priorRelease=await optional(target), previous=await optional(sourceFile);
if(priorRelease && !isDeepStrictEqual(priorRelease,release))throw Error('This version already has different content or review.');
const source={...candidate.source,review:decision};
if(previous && previous.source_revision===source.source_revision && previous.status===source.status) source.review=previous.review;
const effective=admittedClient(product,source), old=previous && admittedClient(product,previous);
const after={schema_version:1,clients:{[release.client_id]:effective}};
if(!checks.remote(effective))throw Error('Invalid hosted Web source');
validateRemoteClientFacts(after);
if(source.source_revision!==expectedSourceRevision(old,effective))throw Error('Incorrect source revision.');
await mkdir(path.dirname(target),{recursive:true});await mkdir(path.dirname(sourceFile),{recursive:true});
const output=data=>JSON.stringify(data,null,2)+'\n';
if(!priorRelease)await writeFile(target,output(release),{flag:'wx'});
const tmp=sourceFile+'.'+randomUUID()+'.tmp';
await writeFile(tmp,output(source),{flag:'wx'});await rename(tmp,sourceFile);
console.log('Prepared the explicitly reviewed release. Run pnpm run project:sources and pnpm check, then finalize the same PR. GitHub validates the actual actor.');
