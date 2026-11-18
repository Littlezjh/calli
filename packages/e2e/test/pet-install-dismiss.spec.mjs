import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { launchBrowser } from '../harness.mjs';

async function fixture() {
  const bundle = await build({
    stdin: { contents: `
      import {createRoot} from 'react-dom/client';
      import {useMemo,useState} from 'react';
      import {Pet,savePetPresence} from './components/Pet';
      const base={id:'dafeiyu',commit:'test',clips:{idle:1},frameMs:84,installed:false,installing:false,error:'fetch failed: ECONNRESET'};
      let status=base, resolveInstall, reads=0;
      function Fixture(){
        const [version,setVersion]=useState(0);
        const [desk,setDesk]=useState(false);
        const api=useMemo(()=>({
          pet:async()=>{reads++;return status},
          installPet:()=>new Promise(resolve=>{resolveInstall=resolve}),
          petFrame:()=> 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          personalProfile:async()=>({isTemplate:false}),
        }),[version]);
        window.petFixture={
          update:(next,isDesk=false)=>{status={...base,...next};setDesk(isDesk);setVersion(v=>v+1)},
          finish:(next)=>{status={...base,...next};resolveInstall?.(status)},
          reads:()=>reads,
        };
        return <>
          <button id="presence-on" onClick={()=>savePetPresence('always')}>常驻</button>
          <button id="presence-off" onClick={()=>savePetPresence('off')}>关</button>
          <div className="composer-slot" style={{position:'fixed',bottom:12,left:16,right:16,height:64,border:'1px solid var(--border)',borderRadius:'var(--radius)',background:'var(--surface)',padding:16}}>继续输入消息</div>
          <Pet api={api} greeting={null} spreadOpen={false} desk={desk} place="thread" threads={[]} onOpenThread={()=>{}} />
        </>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `, loader:'tsx', resolveDir:fileURLToPath(new URL('../../web/src/', import.meta.url)) },
    bundle:true, write:false, format:'iife', platform:'browser', jsx:'automatic',
  });
  const css=readFileSync(new URL('../../web/src/styles.css',import.meta.url),'utf8');
  const server=createServer((_req,res)=>res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div>'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await launchBrowser();
  const open=async(phone,theme)=>{
    const page=await browser.newPage({viewport:phone?{width:390,height:844}:{width:1280,height:800},isMobile:phone,hasTouch:phone,locale:'zh-CN',colorScheme:theme,reducedMotion:'reduce'});
    const load=async()=>{
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      await page.addStyleTag({content:css});
      await page.addScriptTag({content:bundle.outputFiles[0].text});
    };
    await load();
    return {page,load};
  };
  return {open,close:async()=>{await browser.close();await new Promise(resolve=>server.close(resolve))}};
}

test('installation prompts can be closed, stay hidden on reload and reopen from the presence setting', {timeout:60_000}, async()=>{
  const f=await fixture();
  try {
    for(const phone of [false,true])for(const theme of ['light','dark']){
      const {page,load}=await f.open(phone,theme);
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      for(const desk of [false,true])for(const state of ['error','installing','ready']){
        await page.evaluate(({state,desk})=>window.petFixture.update({error:state==='error'?'fetch failed: ECONNRESET':null,installing:state==='installing'},desk),{state,desk});
        await page.locator('#presence-on').click();
        const close=page.getByRole('button',{name:'关闭助手',exact:true});
        await close.waitFor({timeout:3000});
        assert.equal(await close.innerText(),'关闭');
        if(state==='error')assert.equal(await page.getByRole('button',{name:'重试',exact:true}).count(),1);
        if(phone)await page.waitForFunction(()=>{
          const box=document.querySelector('.pet-install-close')?.getBoundingClientRect();
          return box && box.width>=44 && box.height>=44;
        });
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        if(state==='error' && !desk && process.env.CALLI_E2E_SCREENSHOTS_DIR){
          mkdirSync(process.env.CALLI_E2E_SCREENSHOTS_DIR,{recursive:true});
          await page.waitForTimeout(250);
          await page.screenshot({path:`${process.env.CALLI_E2E_SCREENSHOTS_DIR}/pet-dismiss-${phone?'phone':'desktop'}-${theme}.png`});
        }
        if(!phone && state==='error'){
          await close.focus();
          await page.keyboard.press('Enter');
        }else await close.click();
        await page.locator('.pet-away').waitFor({state:'detached'});
        assert.equal(await page.evaluate(()=>localStorage.getItem('calli.pet.presence')),'off');
      }
      await load();
      assert.equal(await page.locator('.pet').count(),0,'a reload keeps the assistant closed');
      assert.equal(await page.evaluate(()=>window.petFixture.reads()),0,'a hidden assistant does not poll installation status');
      await page.locator('#presence-on').click();
      await page.getByRole('button',{name:'关闭助手',exact:true}).waitFor();
      await page.locator('#presence-off').click();
      await page.locator('.pet-away').waitFor({state:'detached'});
      assert.deepEqual(errors,[]);
      await page.close();
    }
  } finally { await f.close(); }
});

test('a late install response stays hidden after closing, including on the desk', {timeout:30_000},async()=>{
  const f=await fixture();
  try{
    const {page}=await f.open(true,'dark');
    for(const installed of [false,true]){
      await page.evaluate(()=>window.petFixture.update({error:null},true));
      await page.locator('#presence-on').click();
      await page.getByRole('button',{name:'召唤助手',exact:true}).click();
      await page.getByRole('status').waitFor();
      await page.getByRole('button',{name:'关闭助手',exact:true}).click();
      await page.evaluate(installed=>window.petFixture.finish({installed,error:installed?null:'fetch failed'}),installed);
      await page.waitForTimeout(50);
      assert.equal(await page.locator('.pet').count(),0,'completion must not reopen a dismissed assistant');
      const reads=await page.evaluate(()=>window.petFixture.reads());
      await page.waitForTimeout(2100);
      assert.equal(await page.evaluate(()=>window.petFixture.reads()),reads,'closing stops installation polling');
    }
    await page.locator('#presence-on').click();
    await page.locator('.pet-body').waitFor();
    await page.locator('#presence-off').click();
    await page.locator('.pet').waitFor({state:'detached'});
  }finally{await f.close()}
});
