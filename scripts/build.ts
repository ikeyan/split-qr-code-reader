const binary = await Deno.readFile('vendor/zxing_reader.wasm');
const encoded = btoa(Array.from(binary, (v) => String.fromCharCode(v)).join(''));
await Deno.writeTextFile('src/wasm-data.ts', `export default ${JSON.stringify(encoded)};\n`);
try {
  await Deno.remove('dist', { recursive: true }).catch(() => {});
  const command = new Deno.Command(Deno.execPath(), { args: ['bundle', '--platform=browser', 'src/index.html', '--outdir=dist'] });
  const result = await command.output();
  await Deno.stdout.write(result.stdout);
  await Deno.stderr.write(result.stderr);
  if (!result.success) Deno.exit(result.code);
  await Deno.copyFile('src/style.css', 'dist/style.css');
  await Deno.copyFile('vendor/zxing-wasm-LICENSE.txt', 'dist/zxing-wasm-LICENSE.txt');
  await Deno.copyFile('vendor/ZXing-APACHE-LICENSE.txt', 'dist/ZXing-APACHE-LICENSE.txt');
  await Deno.writeTextFile('dist/.nojekyll', '');
} finally {
  // Generated locally for type checking as well as bundling.
}
