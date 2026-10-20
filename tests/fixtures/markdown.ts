import assert from 'node:assert/strict';
import type {Page} from 'playwright';
export const markdownReply='## Changes\n\n**Added a paragraph** and kept your original text.\n\n- Preserved the original text\n- Added one paragraph\n\n1. Read the document\n2. Applied the change\n\nUse `append_paragraph`.\n\n```ts\nconst ready = true;\n```\n\n| Item | State |\n| --- | --- |\n| Paragraph | Added |\n\n[Safe link](https://example.test/docs)\n\n[Unsafe link](javascript:alert%281%29)\n\n![Tracking image](https://example.test/pixel.png)\n\n<script>window.markdownExecuted = true</script><img src="https://example.test/raw.png" onerror="window.markdownExecuted = true">';
export async function checkMarkdown(page:Page){
 const reply=page.locator('.assistant').filter({has:page.getByRole('heading',{name:'Changes',exact:true})});
 await reply.getByRole('heading',{name:'Changes',exact:true}).waitFor();
 assert.equal(await reply.locator('strong').innerText(),'Added a paragraph');assert.equal(await reply.locator('ul li').count(),2);assert.equal(await reply.locator('ol li').count(),2);
 assert.match(await reply.locator('pre').innerText(),/const ready = true/);assert.equal(await reply.locator('table td').first().innerText(),'Paragraph');
 assert.equal(await reply.getByRole('link',{name:'Safe link',exact:true}).getAttribute('href'),'https://example.test/docs');
 assert.equal(await reply.locator('a[href^="javascript:"],a[href^="file:"],img,script').count(),0);assert.equal(await page.evaluate(()=>(window as any).markdownExecuted),undefined);
 assert.doesNotMatch(await page.locator('#messages').innerText(),/\b(?:Agent|Codex) [a-f0-9]{4}\b/);
}
