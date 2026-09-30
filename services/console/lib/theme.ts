const key = "lares-console-theme";
export const themeScript = `(function(){try{var t=localStorage.getItem('${key}')||'system';document.documentElement.classList.toggle('dark',t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches));}catch(e){}})()`;
