const fs = require('fs');
let code = fs.readFileSync('electron/services/autoStoryFastService.js', 'utf8');

code = code.replace(/if \(project\.autoStoryContractVersion === 2 \|\| project\.autoStoryContractVersion === 3\) return require\('\.\/autoStorySourceReview'\)\.run\(this, \{ workspaceRoot, projectId, onProgress, signal, onDraft, scriptId \}\);/,
`if (project.autoStoryContractVersion === 2) return require('./autoStorySourceReview').run(this, { workspaceRoot, projectId, onProgress, signal, onDraft, scriptId });
    if (project.autoStoryContractVersion === 3 || project.autoStoryContractVersion === 4) return require('./autoStoryV3Pipeline').auditDrafts(this, { workspaceRoot, projectId, onProgress, signal, onDraft, scriptId });`);

fs.writeFileSync('electron/services/autoStoryFastService.js', code);
