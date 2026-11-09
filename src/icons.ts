import h from 'solid-js/h';
type Icon = 'camera'|'stop'|'image'|'paste'|'reset'|'copy'|'check'|'share'|'delete'|'download'|'expand'|'collapse'|'close'|'torch';
const paths: Record<Icon,string> = {
  camera:'M4 7h3l1.5-2h7L17 7h3v12H4z M15 13a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  stop:'M7 7h10v10H7z',
  image:'M4 2h11l5 5v15H4z M15 2v5h5 M7 10h3v3H7z M14 10h3v3h-3z M7 16h3v3H7z M14 16h1 M17 16v1 M14 19h3',
  paste:'M9 4H5v18h14V4h-4 M9 2h6v4H9z M7 9h3v3H7z M14 9h3v3h-3z M7 16h3v3H7z M14 16h1 M17 16v1 M14 19h3',
  reset:'M12 3v9 M6.6 5.7a8 8 0 1 0 10.8 0',
  copy:'M8 8h11v12H8z M16 8V4H4v12h4',
  check:'M5 12l4 4L19 6',
  share:'M12 16V3 M8 7l4-4 4 4 M5 13v7h14v-7',
  delete:'M4 7h16 M9 7V4h6v3 M18 7l-1 13H7L6 7 M10 11v5 M14 11v5',
  download:'M12 3v12 M8 11l4 4 4-4 M5 17v3h14v-3',
  expand:'M9 4H4v5 M15 4h5v5 M4 15v5h5 M20 15v5h-5',
  collapse:'M4 9h5V4 M20 9h-5V4 M4 15h5v5 M20 15h-5v5',
  close:'M6 6l12 12 M18 6 6 18',
  torch:'M8 3h8l-1 6 3 3-2 3v6H8v-6l-2-3 3-3z M8 15h8 M10 18h4',
};
export function icon(name:Icon){return h('svg',{viewBox:'0 0 24 24','aria-hidden':'true',focusable:'false'},h('path',{d:paths[name],fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round'}));}
