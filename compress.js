const fs = require('fs');
const path = require('path');
const terser = require('terser');
const CleanCSS = require('clean-css');
const { minify: minifyHTML } = require('html-minifier');

const timestamp = Math.floor(Date.now() / 1000);  // 当前时间戳

// —— 可配置：哪些后缀当作“可加戳的本地静态资源” —— //
const JS_EXT = ['.js'];
const CSS_EXT = ['.css'];
const ASSET_EXT_FOR_CSS_URL = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.mp3'];

function walk(dir, extensions, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            walk(fullPath, extensions, fileList);
        } else if (extensions.length === 0 || extensions.includes(path.extname(fullPath).toLowerCase())) {
            fileList.push(fullPath);
        }
    }
    return fileList;
}

// 递归删除目录
function cleanDir(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
        const fullPath = path.join(dir, entry);
        if (fs.statSync(fullPath).isDirectory()) {
            cleanDir(fullPath);
            fs.rmdirSync(fullPath);
        } else {
            fs.unlinkSync(fullPath);
        }
    }
}

// —— 工具：是否是外链/内嵌 —— //
function isExternalLike(u) {
    return /^(?:https?:)?\/\//i.test(u) || /^data:/i.test(u);
}

// —— 工具：为URL追加/更新 t=时间戳（保留 hash） —— //
function withTimestamp(rawUrl) {
    if (!rawUrl) return rawUrl;
    // 拆 hash
    const hashIndex = rawUrl.indexOf('#');
    const hash = hashIndex >= 0 ? rawUrl.slice(hashIndex) : '';
    let url = hashIndex >= 0 ? rawUrl.slice(0, hashIndex) : rawUrl;

    // 已有 t= 则更新，否则追加
    if (/[?&]t=\d+/.test(url)) {
        url = url.replace(/([?&])t=\d+/g, `$1t=${timestamp}`);
    } else {
        url += (url.includes('?') ? '&' : '?') + 't=' + timestamp;
    }
    return url + hash;
}

// —— 只给指定后缀的“本地链接”追加时间戳 —— //
function stampIfLocalWithExt(rawUrl, allowExtList) {
    if (!rawUrl) return rawUrl;
    if (isExternalLike(rawUrl)) return rawUrl; // 跳过外链/内嵌
    const ext = path.extname(rawUrl.split('?')[0].split('#')[0]).toLowerCase();
    if (!allowExtList.includes(ext)) return rawUrl;
    return withTimestamp(rawUrl);
}

// —— 在 HTML 文本里：给 <script src> 与 <link href> 的本地 .js/.css 加戳 —— //
function stampHtmlLinks(html) {
    // <script src="...">
    html = html.replace(/(<script[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi, (m, p1, url, p3) => {
        const stamped = stampIfLocalWithExt(url, JS_EXT);
        return p1 + stamped + p3;
    });
    // <link ... href="...">（主要是 CSS）
    html = html.replace(/(<link[^>]*\bhref=["'])([^"']+)(["'][^>]*>)/gi, (m, p1, url, p3) => {
        const stamped = stampIfLocalWithExt(url, CSS_EXT);
        return p1 + stamped + p3;
    });
    return html;
}

// —— 在 CSS 文本里：给 url(...) 的本地资源加戳（图片/字体等） —— //
function stampCssUrls(css) {
    return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, url) => {
        if (isExternalLike(url)) return m;
        const ext = path.extname(url.split('?')[0].split('#')[0]).toLowerCase();
        if (!ASSET_EXT_FOR_CSS_URL.includes(ext)) return m;
        const stamped = withTimestamp(url);
        return `url(${q || ''}${stamped}${q || ''})`;
    });
}

async function compress() {
    const srcDir = path.resolve(__dirname, 'src');
    const distDir = path.resolve(__dirname, 'dist');

    // 清空 dist 目录
    console.log('🧹 清空 dist 目录...');
    cleanDir(distDir);
    fs.mkdirSync(distDir, { recursive: true });

    // 1. 压缩 JS（内容不改，时间戳由 HTML 引用控制）
    const jsFiles = walk(srcDir, JS_EXT);
    for (const file of jsFiles) {
        const code = fs.readFileSync(file, 'utf8');
        const result = await terser.minify(code);
        if (result.error) {
            console.error(`压缩 JS 错误: ${file}`, result.error);
            continue;
        }
        const relativePath = path.relative(srcDir, file);
        const outPath = path.join(distDir, relativePath);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, result.code);
        console.log(`压缩JS: ${outPath}`);
    }

    // 2. 压缩 CSS（先给 url(...) 加戳，再 minify）
    const cssFiles = walk(srcDir, CSS_EXT);
    const cleaner = new CleanCSS();
    for (const file of cssFiles) {
        let code = fs.readFileSync(file, 'utf8');
        code = stampCssUrls(code); // ★ 给 CSS 内部资源加戳
        const output = cleaner.minify(code);
        if (output.errors.length) {
            console.error(`压缩 CSS 错误: ${file}`, output.errors);
            continue;
        }
        const relativePath = path.relative(srcDir, file);
        const outPath = path.join(distDir, relativePath);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, output.styles);
        console.log(`压缩CSS: ${outPath}`);
    }

    // 3. 压缩 HTML：先替换已有 t=，再给 <script>/<link> 加戳
    const htmlFiles = walk(srcDir, ['.html']);
    for (const file of htmlFiles) {
        let code = fs.readFileSync(file, 'utf8');

        // 3.1 替换已有 t= 时间戳参数（防旧值）
        code = code.replace(/([?&])t=\d+/g, `$1t=${timestamp}`);

        // 3.2 给 <script src> / <link href> 自动追加或更新 t=
        code = stampHtmlLinks(code);

        // 3.3 压缩 HTML
        const minHtml = minifyHTML(code, {
            collapseWhitespace: true,
            removeComments: true,
            minifyJS: true,
            minifyCSS: true,
        });

        const relativePath = path.relative(srcDir, file);
        const outPath = path.join(distDir, relativePath);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, minHtml);
        console.log(`压缩HTML: ${outPath}`);
    }

    // 4. 拷贝其他资源（非 .js/.css/.html）
    const allFiles = walk(srcDir, []);
    for (const file of allFiles) {
        const ext = path.extname(file).toLowerCase();
        if (!JS_EXT.includes(ext) && !CSS_EXT.includes(ext) && ext !== '.html') {
            const relativePath = path.relative(srcDir, file);
            const destPath = path.join(distDir, relativePath);
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(file, destPath);
            console.log(`拷贝资源文件: ${destPath}`);
        }
    }

    console.log('\n✅ 所有文件处理完成');
    console.log('⏱️ 时间戳 t =', timestamp);
}

compress();
