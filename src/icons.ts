import h from 'solid-js/h';
type Icon = 'camera'|'stop'|'image'|'paste'|'reset'|'copy'|'check'|'share'|'delete'|'download'|'expand'|'collapse'|'close';
const paths: Record<Icon,string> = {
  camera:'M4 7h3l1.5-2h7L17 7h3v12H4z M15 13a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  stop:'M7 7h10v10H7z',
  image:'M5 3h10l4 4v14H5z M15 3v5h4 M8 11h2v2H8z M14 11h2v2h-2z M8 16h2v2H8z M14 16h1m1 0h1m-3 2h3',
  paste:'M9 5H6v16h12V5h-3 M9 3h6v4H9z M9 11h6 M9 15h6',
  reset:'M12 3v9 M6.6 5.7a8 8 0 1 0 10.8 0',
  copy:'M8 8h11v12H8z M16 8V4H4v12h4',
  check:'M5 12l4 4L19 6',
  share:'M12 16V3 M8 7l4-4 4 4 M5 13v7h14v-7',
  delete:'M4 7h16 M9 7V4h6v3 M18 7l-1 13H7L6 7 M10 11v5 M14 11v5',
  download:'M12 3v12 M8 11l4 4 4-4 M5 17v3h14v-3',
  expand:'M9 4H4v5 M15 4h5v5 M4 15v5h5 M20 15v5h-5',
  collapse:'M4 9h5V4 M20 9h-5V4 M4 15h5v5 M20 15h-5v5',
  close:'M6 6l12 12 M18 6 6 18',
};
export function icon(name:Icon){return h('svg',{viewBox:'0 0 24 24','aria-hidden':'true',focusable:'false'},h('path',{d:paths[name],fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round'}));}
