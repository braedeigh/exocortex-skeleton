// md.js — shared hand-rolled markdown -> HTML renderer + entity color helper.
// Extracted verbatim from journal.html's renderPreview/entityHue so behavior stays
// byte-identical wherever it's used (journal.html, person.html). Deliberately tiny
// (headings, hr, bold/italic, inline code, blockquote, lists, paragraphs) — not a
// full markdown engine.

// text -> HTML string. Caller is responsible for handling the "empty" case.
window.mdToHtml = function mdToHtml(text) {
    let md = text == null ? '' : text;
    md = md.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    md = md.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    md = md.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    md = md.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    md = md.replace(/^---+$/gm, '<hr>');
    md = md.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    md = md.replace(/\*(.+?)\*/g, '<em>$1</em>');
    md = md.replace(/`([^`]+)`/g, '<code>$1</code>');
    md = md.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
    md = md.replace(/^- (.+)$/gm, '<li>$1</li>');
    md = md.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
    md = md.replace(/\n\n/g, '</p><p>');
    md = '<p>' + md + '</p>';
    md = md.replace(/<p><(h[123]|hr|ul|blockquote)/g, '<$1');
    md = md.replace(/<\/(h[123]|ul|blockquote)><\/p>/g, '</$1>');
    return md;
};

// Deterministic hue per name so each person keeps the same color everywhere.
window.entityHue = function entityHue(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
};
