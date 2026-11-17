// Sign out ends the session on the server, then returns to the sign-in page.
document.addEventListener('click', async event => {
  if (!event.target.closest?.('[data-signout]')) return;
  try {
    const me = await (await fetch('/api/me')).json();
    await fetch('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrf }, body: '{}' });
  } catch { /* already signed out: still go to the sign-in page */ }
  location.href = '/signin';
});
document.addEventListener('submit', async event => {
 const form=event.target;if(!form.matches('form[data-private-post]'))return;event.preventDefault();
 if(form.dataset.busy)return;  // a second click while the first is still going
 let release=()=>{};
 try {
  const input=Object.fromEntries(new FormData(form));
  form.dataset.busy='1';const buttons=[...form.querySelectorAll('button')];for(const b of buttons)b.disabled=true;release=()=>{delete form.dataset.busy;for(const b of buttons)b.disabled=false;};
  if(Object.hasOwn(input,'enabled'))input.enabled=input.enabled==='true';
  if(Object.hasOwn(input,'shared_with'))input.shared_with=input.shared_with||null;
  const me=await(await fetch('/api/me')).json();
  const response=await fetch(form.dataset.privatePost,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':me.csrf},body:JSON.stringify(input)});
  if(!response.ok)throw Error('refused');
  const out=await response.json();
  if(form.dataset.next==='request')location.href=`/mentoring/${encodeURIComponent(out.id)}`;
  else location.reload();
 }catch{
  release();
  let error=form.querySelector('[role=alert]');if(!error){error=document.createElement('p');error.setAttribute('role','alert');form.append(error);}
  error.textContent='That did not go through. You may have been signed out, or the request may have changed. Reload the page, check your choices, and try again.';
 }
});
