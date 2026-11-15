document.addEventListener('submit', async event => {
 const form=event.target;if(!form.matches('form[data-private-post]'))return;event.preventDefault();
 try {
  const input=Object.fromEntries(new FormData(form));
  if(Object.hasOwn(input,'enabled'))input.enabled=input.enabled==='true';
  if(Object.hasOwn(input,'shared_with'))input.shared_with=input.shared_with||null;
  const me=await(await fetch('/api/me')).json();
  const response=await fetch(form.dataset.privatePost,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':me.csrf},body:JSON.stringify(input)});
  if(!response.ok)throw Error('refused');
  const out=await response.json();
  if(form.dataset.next==='request')location.href=`/mentoring/${encodeURIComponent(out.id)}`;
  else location.reload();
 }catch{
  let error=form.querySelector('[role=alert]');if(!error){error=document.createElement('p');error.setAttribute('role','alert');form.append(error);}
  error.textContent='That did not go through. Check your consent, sharing choice, and request status.';
 }
});
