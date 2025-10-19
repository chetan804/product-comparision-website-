const template = document.getElementById('card-template');
const resultsEl = document.getElementById('results');
const searchInput = document.getElementById('search');
const searchBtn = document.getElementById('searchBtn');

async function searchProducts(q){
  const res = await fetch('/api/search?q=' + encodeURIComponent(q));
  if(!res.ok){
    const data = await res.json().catch(()=>({error:'Search failed'}));
    throw new Error(data.error || 'search error');
  }
  return res.json();
}

function renderResults(items){
  resultsEl.innerHTML = '';
  if(!items || items.length === 0){
    resultsEl.innerHTML = '<p style="padding:16px">No results found.</p>';
    return;
  }
  items.forEach(it => {
    const node = template.content.cloneNode(true);
    const img = node.querySelector('.thumb');
    img.src = it.thumbnail || 'https://via.placeholder.com/300x200?text=No+Image';
    node.querySelector('.title').textContent = it.title || 'No title';
    node.querySelector('.source').textContent = (it.source || 'unknown').toUpperCase();
    node.querySelector('.price').textContent = (typeof it.price === 'number') ? ('₹' + it.price.toFixed(2)) : 'Price not available';
    const a = node.querySelector('.buy');
    a.href = it.link || '#';
    a.target = '_blank';
    resultsEl.appendChild(node);
  });
}

async function doSearch(){
  const q = searchInput.value.trim();
  if(!q) return;
  resultsEl.innerHTML = '<p style="padding:16px">Searching...</p>';
  try {
    const data = await searchProducts(q);
    renderResults(data.results || []);
  } catch(err){
    resultsEl.innerHTML = `<p style="padding:16px;color:red">${err.message}</p>`;
  }
}

searchBtn.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', (e) => { if(e.key === 'Enter') doSearch(); });

// initial sample search
// doSearch();
