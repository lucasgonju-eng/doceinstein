const toast = document.getElementById('toast');

function showToast(msg){
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(()=>toast.classList.remove('show'), 1200);
}

document.querySelectorAll('.hotspot').forEach(a=>{
  a.addEventListener('click', (e)=>{
    // demo only; remove if you want normal navigation/route handling
    e.preventDefault();
    const label = a.getAttribute('aria-label') || 'Ação';
    showToast(label);
  });
});
