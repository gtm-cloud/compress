const fs = require('fs');
const path = require('path');
const terser = require('terser');
const CleanCSS = require('clean-css');
const { minify: minifyHTML } = require('html-minifier');

const timestamp = Math.floor(Date.now() / 1000);  // 当前时间戳

function walk(dir, extensions, fileList = []) {
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

async function compress() {
    const srcDir = path.resolve(__dirname, 'src');
    const distDir = path.resolve(__dirname, 'dist');

    // 清空 dist 目录
    console.log('🧹 清空 dist 目录...');
    cleanDir(distDir);
    fs.mkdirSync(distDir, { recursive: true });

    // 1. 压缩 JS
    const jsFiles = walk(srcDir, ['.js']);
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

    // 2. 压缩 CSS
    const cssFiles = walk(srcDir, ['.css']);
    const cleanCSS = new CleanCSS();
    for (const file of cssFiles) {
        const code = fs.readFileSync(file, 'utf8');
        const output = cleanCSS.minify(code);
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

    // 3. 压缩 HTML 并更新 t= 时间戳
    const htmlFiles = walk(srcDir, ['.html']);
    for (const file of htmlFiles) {
        let code = fs.readFileSync(file, 'utf8');

        // 替换 t= 时间戳参数
        code = code.replace(/([?&])t=\d+/g, `$1t=${timestamp}`);

        // 压缩 HTML
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
        if (!['.js', '.css', '.html'].includes(ext)) {
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
