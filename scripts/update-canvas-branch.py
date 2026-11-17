#!/usr/bin/env python3
"""Extract the committed canvas from a clean local workspace into main."""
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ALLOWED = {'.github', '.gitignore', '.githooks', 'AGENTS.md', 'LICENSE',
           'README.md', 'THIRD_PARTY_NOTICES.md', 'fusion', 'fusion-native',
           'integrations', 'ketcher-local', 'scripts', 'skills'}
EXCLUDED_PATHS = {
    'fusion/GEMINI_WELCOME_TASK.md',
    'fusion-native/WELCOME_COMPONENT_HANDOFF.md',
}


def git(*args, env=None, data=None):
    return subprocess.check_output(['git', *args], cwd=ROOT, env=env, input=data)


def main():
    if git('status', '--porcelain', '--untracked-files=normal').strip():
        raise SystemExit('请先提交本地改动，再更新画布 main。')
    branch = git('branch', '--show-current').decode().strip()
    if branch == 'main':
        print('当前已在画布 main；提交后可推送 main:main。')
        return
    if branch != 'codex/local-workspace':
        raise SystemExit('请在 codex/local-workspace 完整开发分支执行。')
    worktrees = git('worktree', 'list', '--porcelain').decode().splitlines()
    if 'branch refs/heads/main' in worktrees:
        raise SystemExit('main 已在其他工作树打开，请先结束该工作树的编辑。')
    previous = git('rev-parse', 'refs/heads/main').decode().strip()
    paths = git('ls-tree', '-r', '--name-only', '-z', 'HEAD').split(b'\0')
    excluded = [
        p for p in paths
        if p and (
            p.decode().split('/', 1)[0] not in ALLOWED
            or p.decode() in EXCLUDED_PATHS
        )
    ]
    with tempfile.TemporaryDirectory(prefix='molstudio-canvas-index-') as temp:
        env = {**os.environ, 'GIT_INDEX_FILE': str(Path(temp) / 'index')}
        git('read-tree', 'HEAD', env=env)
        if excluded:
            git('update-index', '--force-remove', '-z', '--stdin', env=env,
                data=b'\0'.join(excluded) + b'\0')
        tree = git('write-tree', env=env).decode().strip()
    if tree == git('rev-parse', previous + '^{tree}').decode().strip():
        print('画布 main 已是本地最新源码。')
        return
    commit = git('commit-tree', tree, '-p', previous,
                 data=b'Update MolStudio canvas from local workspace\n').decode().strip()
    git('update-ref', 'refs/heads/main', commit, previous)
    print('画布 main 已更新：' + commit[:12])
    print('本地文档应用保留在原分支。发布：git push origin main:main')


if __name__ == '__main__':
    main()
