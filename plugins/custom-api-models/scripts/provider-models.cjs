"use strict";
// Public model declarations contain capabilities, never credentials or URLs.
const { LEVELS, mergeModel } = require("./effort.cjs");
const object=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const bad=()=>{throw Error("invalid imported model capabilities");};
const safeId=id=>typeof id==="string"&&id.trim()===id&&id.length>0&&id.length<=512&&!/[\x00-\x1f\x7f]/.test(id);
const top=["template","label","maxInputTokens","maxOutputTokens","contextWindow","supportsToolCall","supportsImages","supportsReasoning","onlyReasoning","useCustomProtocol","compat","reasoning","thinkingLevelMap"];
function fields(v,allowed){if(!object(v)||Object.keys(v).some(k=>!allowed.includes(k)||["__proto__","constructor","prototype"].includes(k)))bad();}
function validateModel(v) {
  fields(v,top);
  for(const k of ["template","label"])if(own(v,k)&&(!safeId(v[k])))bad();
  for(const k of ["maxInputTokens","maxOutputTokens","contextWindow"])if(own(v,k)&&(!Number.isSafeInteger(v[k])||v[k]<1||v[k]>100000000))bad();
  if(v.maxInputTokens!==undefined&&v.maxInputTokens<1024)bad();
  for(const k of ["supportsToolCall","supportsImages","supportsReasoning","onlyReasoning","useCustomProtocol"])if(own(v,k)&&typeof v[k]!=="boolean")bad();
  if(own(v,"reasoning")) {
    fields(v.reasoning,["supportedEfforts","canDisableThinking","defaultEffort","effort","summary"]);
    const r=v.reasoning;
    if(own(r,"supportedEfforts")&&(!Array.isArray(r.supportedEfforts)||r.supportedEfforts.some(x=>!LEVELS.includes(x))||new Set(r.supportedEfforts).size!==r.supportedEfforts.length))bad();
    if(own(r,"canDisableThinking")&&typeof r.canDisableThinking!=="boolean")bad();
    for(const k of ["defaultEffort","effort"])if(own(r,k)&&r[k]!==null&&!LEVELS.includes(r[k])&&!["off","on"].includes(r[k]))bad();
    if(own(r,"summary")&&!["auto","concise","detailed","none"].includes(r.summary))bad();
    if(r.defaultEffort!==undefined&&r.defaultEffort!==null&&r.supportedEfforts?.length&&!r.supportedEfforts.includes(r.defaultEffort)&&r.defaultEffort!=="off")bad();
  }
  if(own(v,"compat")) {
    fields(v.compat,["thinkingFormat","maxTokensField","supportsReasoningEffort","supportsTemperature","supportsDeveloperRole","supportsStrictMode","apiType"]);
    if(own(v.compat,"thinkingFormat")&&!["qwen","openai","anthropic","deepseek","zai","none"].includes(v.compat.thinkingFormat))bad();
    if(own(v.compat,"maxTokensField")&&!["max_tokens","max_completion_tokens","max_output_tokens"].includes(v.compat.maxTokensField))bad();
    for(const k of ["supportsReasoningEffort","supportsTemperature","supportsDeveloperRole","supportsStrictMode"])if(own(v.compat,k)&&typeof v.compat[k]!=="boolean")bad();
    if(own(v.compat,"apiType")&&!["chat-completions","responses","messages"].includes(v.compat.apiType))bad();
  }
  if(own(v,"thinkingLevelMap")) {
    fields(v.thinkingLevelMap,["off","on",...LEVELS]);
    for(const value of Object.values(v.thinkingLevelMap))if(value!==null&&value!=="none"&&value!=="on"&&value!=="off"&&!LEVELS.includes(value))bad();
  }
  if(v.onlyReasoning===true&&v.reasoning?.canDisableThinking===true)bad();
  return v;
}
function validateModels(models) { fields(models,Object.keys(models||{})); for(const [id,v]of Object.entries(models)){if(!safeId(id))bad();validateModel(v);}return models; }
function declaredModel(provider,id,preset=null,override=null) {
  const spec=mergeModel(preset?.models?.[id],provider.models?.[id],override);
  const template=spec.template&&preset?.templates?.[spec.template];
  const result=mergeModel(template||provider.defaults||{},spec);delete result.template;
  // Unknown capacity stays unknown; importing a name never invents 128k/tool/reasoning support.
  return result;
}
function safeModels(models={}) {
  const out={};for(const [id,v]of Object.entries(models)){if(!safeId(id)||!object(v))continue;const safe=Object.fromEntries(Object.entries(v).filter(([k])=>top.includes(k)));validateModel(safe);out[id]=safe;}return out;
}
function patchModels(values,previous={}){
 if(!object(values))bad();const out={};
 const flat=['supportsTools','supportedEfforts','canDisableThinking','defaultEffort','protocolCompat'];
 for(const [id,v]of Object.entries(values)){
  if(!safeId(id)||!object(v)||Object.keys(v).some(k=>!top.includes(k)&&!flat.includes(k)))bad();
  const m=mergeModel(previous[id]);
  for(const [k,value]of Object.entries(v)){
   if(k==='protocolCompat'){if(value!==null&&(!Array.isArray(value)||value.some(x=>x!=='openai-chat')))bad();continue;}
   if(k==='supportsTools'){if(value!==null)m.supportsToolCall=value;continue;}
   if(['supportedEfforts','canDisableThinking','defaultEffort'].includes(k)){
    if(value===null){if(m.reasoning)delete m.reasoning[k];if(k==='supportedEfforts'){delete m.thinkingLevelMap;delete m.supportsReasoning;if(m.compat)delete m.compat.supportsReasoningEffort;}continue;}m.reasoning={...m.reasoning,[k]:value};
    if(k==='supportedEfforts'){m.supportsReasoning=value.length>0||m.reasoning?.canDisableThinking===true;m.compat={...m.compat,thinkingFormat:m.compat?.thinkingFormat||'openai',supportsReasoningEffort:value.length>0};m.thinkingLevelMap={...m.thinkingLevelMap,...Object.fromEntries(value.map(x=>[x,x]))};}
    if(k==='canDisableThinking'){
     if(value===true){m.supportsReasoning=true;m.compat={...m.compat,thinkingFormat:m.compat?.thinkingFormat||'openai'};m.thinkingLevelMap={...m.thinkingLevelMap,off:m.thinkingLevelMap?.off??'none'};}
     else if(m.thinkingLevelMap)delete m.thinkingLevelMap.off;
    }
    continue;
   }
   if(value===null)delete m[k];else m[k]=value;
  }
  validateModel(m);out[id]=m;
 }
 return out;
}
function route(v,providers) {
  if(!object(v))return v;
  fields(v,["provider","model","effort"]);
  if(!safeId(v.provider)||!providers[v.provider]||!safeId(v.model))throw Error("route requires a configured provider and model");
  if(v.effort!==undefined&&v.effort!==null&&!LEVELS.includes(v.effort)&&!["off","on"].includes(v.effort))throw Error("invalid route effort");
  return {...v};
}
module.exports={safeId,validateModel,validateModels,declaredModel,safeModels,patchModels,route};
