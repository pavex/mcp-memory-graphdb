#!/usr/bin/env node
// Brings the sources to the code style of mcp-hub-v2 (docs/code-style.md) - the mechanical
// part: 4-space indent, no semicolons, single quotes, no trailing commas,
// braces on every if / else / for / while body, `else` / `catch` / `finally`
// on a new line, single spaces between tokens (no column alignment), `x =>`
// without parentheses, two blank lines between top-level declarations and
// between class members, fields together.
//
// Built on the TypeScript formatter (devDependency), no other dependencies.
//
//   npm run style             restyles src, test, scripts and esbuild.config.mjs
//   npm run style -- --check  lists files that differ, exit code 1 if any
//   node scripts/restyle.mjs <files...>

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'


const root = resolve(import.meta.dirname, '..')
const DEFAULT_PATHS = ['src', 'test', 'scripts', 'esbuild.config.mjs']


const args = process.argv.slice(2)
const check = args.includes('--check')
const paths = args.filter(arg => arg !== '--check')
const files = (paths.length ? paths : DEFAULT_PATHS.map(path => join(root, path))).flatMap(listFiles)

let changed = 0
for (const file of files) {
    const before = readFileSync(file, 'utf8')
    const after = restyle(file, before)
    if (after !== before.replace(/\r\n/g, '\n')) {
        changed++
        if (!check) {
            writeFileSync(file, after)
        }
        console.log(`${check ? 'differs' : 'restyled'} ${file}`)
    }
}
if (check && changed) {
    process.exitCode = 1
}


function listFiles(path) {
    if (!statSync(path).isDirectory()) {
        return [path]
    }
    return readdirSync(path, { recursive: true })
        .map(entry => join(path, entry))
        .filter(file => /\.(ts|mjs|js)$/.test(file) && !file.endsWith('.d.ts') && !/[\\/]node_modules[\\/]/.test(file))
}


function restyle(file, text) {
    let out = text.replace(/\r\n/g, '\n')
    out = structure(file, out)
    out = arrowParentheses(file, out)
    out = format(file, out)
    out = collapseSpaces(file, out)
    out = format(file, out)
    out = blankLines(file, out)
    return out.replace(/[ \t]+$/gm, '').replace(/\n{4,}/g, '\n\n\n').replace(/\s*$/, '\n')
}


function parse(file, text) {
    const kind = /\.m?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
    return ts.createSourceFile(file.replace(/\.mjs$/, '.js'), text, ts.ScriptTarget.Latest, true, kind)
}


// Applies non-overlapping edits from the end; insertions at one position all apply.
function applyEdits(text, edits) {
    let out = text
    for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
        out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
    }
    return out
}


// Braces, quotes, trailing commas, `} else`, class field semicolons, type
// literal separators, empty function bodies - read from the AST.
function structure(file, text) {
    const source = parse(file, text)
    const edits = []

    const wrap = statement => {
        if (statement && !ts.isBlock(statement)) {
            edits.push({ start: statement.getStart(source), end: statement.getStart(source), text: '{\n' })
            edits.push({ start: statement.getEnd(), end: statement.getEnd(), text: '\n}' })
        }
    }
    const dropTrailingComma = list => {
        if (list?.hasTrailingComma && list.length) {
            const comma = text.indexOf(',', list[list.length - 1].getEnd())
            edits.push({ start: comma, end: comma + 1, text: '' })
        }
    }
    const newLineBefore = (keyword, from, to) => {
        const position = text.indexOf(keyword, from)
        if (position >= 0 && position <= to && text.slice(from, position).trim() === '' && !text.slice(from, position).includes('\n')) {
            edits.push({ start: from, end: position, text: '\n' })
        }
    }

    const visit = node => {
        if (ts.isIfStatement(node)) {
            wrap(node.thenStatement)
            if (node.elseStatement && !ts.isIfStatement(node.elseStatement)) {
                wrap(node.elseStatement)
            }
            if (node.elseStatement) {
                newLineBefore('else', node.thenStatement.getEnd(), node.elseStatement.getStart(source))
            }
        }
        else if (ts.isIterationStatement(node, false)) {
            wrap(node.statement)
        }
        if (ts.isTryStatement(node)) {
            if (node.catchClause) {
                newLineBefore('catch', node.tryBlock.getEnd(), node.catchClause.getStart(source))
            }
            if (node.finallyBlock) {
                newLineBefore('finally', (node.catchClause ?? node.tryBlock).getEnd(), node.finallyBlock.getStart(source))
            }
        }
        if (ts.isStringLiteral(node)) {
            const raw = node.getText(source)
            if (raw.startsWith('"') && !raw.includes("'")) {
                edits.push({ start: node.getStart(source), end: node.getEnd(), text: `'${raw.slice(1, -1).replace(/\\"/g, '"')}'` })
            }
        }
        if (ts.isObjectLiteralExpression(node)) {
            dropTrailingComma(node.properties)
        }
        if (ts.isArrayLiteralExpression(node) || ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)
            || ts.isNamedImports(node) || ts.isNamedExports(node)) {
            dropTrailingComma(node.elements)
        }
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            dropTrailingComma(node.arguments)
        }
        if (ts.isFunctionLike(node)) {
            dropTrailingComma(node.parameters)
        }
        if (ts.isEnumDeclaration(node)) {
            dropTrailingComma(node.members)
        }
        if (ts.isPropertyDeclaration(node) && text[node.getEnd() - 1] === ';') {
            edits.push({ start: node.getEnd() - 1, end: node.getEnd(), text: '' })
        }
        if (ts.isTypeLiteralNode(node) && !node.getText(source).includes('\n')) {
            node.members.forEach((member, index) => {
                const end = member.getEnd()
                if (text[end - 1] === ';' || text[end - 1] === ',') {
                    edits.push({ start: end - 1, end, text: index === node.members.length - 1 ? '' : ',' })
                }
            })
        }
        if ((ts.isConstructorDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node))
            && node.body?.statements.length === 0 && !/\/[/*]/.test(node.body.getText(source))) {
            edits.push({ start: node.body.getStart(source), end: node.body.getEnd(), text: '{\n}' })
        }
        ts.forEachChild(node, visit)
    }
    visit(source)
    return applyEdits(text, edits)
}


// `(x) =>` and `async (x) =>` become `x =>` when x has no type, default or rest.
function arrowParentheses(file, text) {
    const source = parse(file, text)
    const edits = []
    const visit = node => {
        if (ts.isArrowFunction(node) && node.parameters.length === 1 && !node.typeParameters && !node.type) {
            const param = node.parameters[0]
            if (ts.isIdentifier(param.name) && !param.type && !param.initializer && !param.dotDotDotToken && !param.questionToken) {
                const paramStart = param.getStart(source)
                const open = text.lastIndexOf('(', paramStart)
                const close = text.indexOf(')', param.getEnd())
                if (open >= node.getStart(source) && text.slice(open + 1, paramStart).trim() === ''
                    && close < node.equalsGreaterThanToken.getStart(source) && text.slice(param.getEnd(), close).trim() === '') {
                    edits.push({ start: open, end: close + 1, text: param.name.text })
                }
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(source)
    return applyEdits(text, edits)
}


// The TypeScript formatter: indentation, spacing, semicolons removed where safe.
function format(file, text) {
    const name = file.replace(/\.mjs$/, '.js')
    const service = ts.createLanguageService({
        getScriptFileNames: () => [name],
        getScriptVersion: () => '1',
        getScriptSnapshot: requested => (requested === name ? ts.ScriptSnapshot.fromString(text) : undefined),
        getCurrentDirectory: () => '',
        getCompilationSettings: () => ({ allowJs: true, noLib: true }),
        getDefaultLibFileName: () => 'lib.d.ts',
        fileExists: requested => requested === name,
        readFile: () => text
    })
    const edits = service.getFormattingEditsForDocument(name, {
        indentSize: 4,
        tabSize: 4,
        convertTabsToSpaces: true,
        newLineCharacter: '\n',
        indentStyle: ts.IndentStyle.Smart,
        semicolons: ts.SemicolonPreference.Remove,
        insertSpaceAfterCommaDelimiter: true,
        insertSpaceAfterSemicolonInForStatements: true,
        insertSpaceBeforeAndAfterBinaryOperators: true,
        insertSpaceAfterKeywordsInControlFlowStatements: true,
        insertSpaceAfterFunctionKeywordForAnonymousFunctions: true,
        insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true,
        insertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces: false,
        insertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis: false,
        insertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: false,
        insertSpaceAfterTypeAssertion: false,
        placeOpenBraceOnNewLineForFunctions: false,
        placeOpenBraceOnNewLineForControlBlocks: false
    })
    return applyEdits(text, edits.map(edit => ({ start: edit.span.start, end: edit.span.start + edit.span.length, text: edit.newText })))
}


// Runs of spaces between tokens on one line become one space (no column
// alignment). Indentation, strings, templates, regexps and comments stay.
function collapseSpaces(file, text) {
    const source = parse(file, text)
    const literals = []
    const visit = node => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || ts.isRegularExpressionLiteral(node)) {
            literals.push([node.getStart(source), node.getEnd()])
            return
        }
        ts.forEachChild(node, visit)
    }
    visit(source)

    const edits = []
    let offset = 0
    for (const line of text.split('\n')) {
        const indent = line.match(/^\s*/)[0].length
        for (const match of line.matchAll(/ {2,}/g)) {
            const position = offset + match.index
            const before = line.slice(0, match.index)
            const rest = line.slice(match.index + match[0].length)
            const inLiteral = literals.some(([start, end]) => position > start && position < end)
            const inComment = /\/\/|\/\*|^\s*\*/.test(before) && !/^\s*\/\//.test(rest)
            if (match.index >= indent && rest !== '' && !inLiteral && !inComment) {
                edits.push({ start: position, end: position + match[0].length, text: ' ' })
            }
        }
        offset += line.length + 1
    }
    return applyEdits(text, edits)
}


// Two blank lines after the imports, around top-level declarations and
// between class members; one after a class's opening brace; fields together.
function blankLines(file, text) {
    const source = parse(file, text)
    const edits = []
    const lineStart = position => text.lastIndexOf('\n', position - 1) + 1
    const commentStart = node => lineStart(node.getFullStart() + text.slice(node.getFullStart()).match(/^\s*/)[0].length)
    const blankLinesBefore = (node, count) => {
        const start = commentStart(node)
        let cursor = start - 1
        while (cursor >= 0 && /\s/.test(text[cursor])) {
            cursor--
        }
        const previousEnd = text.indexOf('\n', cursor)
        if (cursor >= 0 && previousEnd >= 0 && previousEnd < start) {
            edits.push({ start: previousEnd, end: start, text: '\n'.repeat(count + 1) })
        }
    }
    const isDeclaration = node => ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)
        || ts.isEnumDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isModuleDeclaration(node)

    source.statements.forEach((statement, index) => {
        const previous = source.statements[index - 1]
        if (!previous) {
            return
        }
        if ((ts.isImportDeclaration(previous) && !ts.isImportDeclaration(statement)) || isDeclaration(statement) || isDeclaration(previous)) {
            blankLinesBefore(statement, 2)
        }
    })

    const visit = node => {
        if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
            node.members.forEach((member, index) => {
                if (index === 0) {
                    const lineEnd = text.indexOf('\n', text.indexOf('{', node.members.pos - 1))
                    if (lineEnd >= 0 && lineEnd < commentStart(member)) {
                        edits.push({ start: lineEnd, end: commentStart(member), text: '\n\n' })
                    }
                }
                else {
                    const fields = ts.isPropertyDeclaration(node.members[index - 1]) && ts.isPropertyDeclaration(member)
                    blankLinesBefore(member, fields ? 0 : 2)
                }
            })
        }
        ts.forEachChild(node, visit)
    }
    visit(source)
    return applyEdits(text, edits)
}
