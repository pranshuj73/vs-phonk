import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import * as os from 'os';

interface LinterState {
	errorCount: number;
	fileErrors: Map<string, number>;
}

const TIMEOUT = 10000;
const MAX_HISTORY = 3;

export function activate(context: vscode.ExtensionContext) {
	const linterState: LinterState = {
		errorCount: 0,
		fileErrors: new Map()
	};

	let sidebarWebview: vscode.WebviewView | undefined;
	let isAudioPlaying = false;
	let lastFaceIndices: number[] = [];
	let lastAudioIndices: number[] = [];

	const getRandomAsset = (directory: string): string | null => {
		const assetsPath = path.join(context.extensionPath, 'assets', directory);
		if (!fs.existsSync(assetsPath)) { return null; };
		
		const files = fs.readdirSync(assetsPath);
		const validFiles = files.filter(file => {
			const extensions = directory === 'faces' 
				? ['.png', '.jpg', '.jpeg']
				: ['.ogg', '.mp3', '.wav'];
			return extensions.some(ext => file.endsWith(ext));
		});

		if (validFiles.length === 0) { return null; };

		const lastIndices = directory === 'faces' ? lastFaceIndices : lastAudioIndices;
		const minFiles = directory === 'faces' ? 1 : MAX_HISTORY;
		
		let randomIndex;
		do {
			randomIndex = Math.floor(Math.random() * validFiles.length);
		} while (lastIndices.includes(randomIndex) && validFiles.length > minFiles);
		
		lastIndices.push(randomIndex);
		if (lastIndices.length > MAX_HISTORY) {
			lastIndices.shift();
		}

		return path.join(assetsPath, validFiles[randomIndex]);
	};

	const getAudioDuration = async (soundPath: string): Promise<number> => {
		const platform = os.platform();
		
		try {
			const ffprobeCmd = `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${soundPath}"`;
			const result = await new Promise<string>((resolve) => {
				exec(ffprobeCmd, (error, stdout) => {
					if (error) {
						// Fallback commands based on platform
						const fallbackCmd = platform === 'win32' 
							? `powershell -c "(New-Object Media.SoundPlayer '${soundPath}').Load(); [System.Media.SoundPlayer]::new('${soundPath}').Load(); (Get-Item '${soundPath}').Length"`
							: `mediainfo --Inform="General;%Duration%" "${soundPath}"`;
						
						exec(fallbackCmd, (error2, stdout2) => {
							if (error2) {
								exec(`soxi -D "${soundPath}"`, (error3, stdout3) => {
									resolve(stdout3 || '5');
								});
							} else {
								resolve(stdout2);
							}
						});
					} else {
						resolve(stdout);
					}
				});
			});
			return Math.floor(parseFloat(result.trim()) * 1000) || 5000;
		} catch (error) {
			console.log('vs-phonk: Could not get audio duration, using fallback');
			return 5000;
		}
	};

	const playSystemAudio = async (soundPath: string) => {
		const platform = os.platform();
		
		const tryCommand = (command: string): Promise<boolean> => {
			return new Promise((resolve) => {
				exec(command, (error) => resolve(!error));
			});
		};
		
		const commands = {
			win32: [
				`powershell -c "(New-Object Media.SoundPlayer '${soundPath}').PlaySync()"`,
				`start /min "" "${soundPath}"`,
				`powershell -c "[console]::beep(800,200); [console]::beep(1000,200); [console]::beep(1200,200)"`
			],
			darwin: [
				`afplay -v 0.3 "${soundPath}"`,
				`osascript -e "set volume output volume 30" && afplay "${soundPath}"`,
				`open "${soundPath}"`
			],
			linux: [
				`paplay --volume=32768 "${soundPath}"`,
				`aplay "${soundPath}"`,
				`mpv --volume=30 "${soundPath}" --no-video`,
				`ffplay -nodisp -autoexit -volume 30 "${soundPath}"`,
				`play "${soundPath}"`,
				`mplayer "${soundPath}" -volume 30`,
				`vlc --intf dummy "${soundPath}" vlc://quit`
			]
		};

		const platformCommands = commands[platform as keyof typeof commands] || commands.linux;
		
		for (const command of platformCommands) {
			if (await tryCommand(command)) { return null; };
		}
	};

	const updateSidebar = async (showCelebration: boolean = false) => {
		if (!sidebarWebview) {
			console.log('vs-phonk: No sidebar webview available');
			return;
		}

		if (showCelebration) {
			console.log('vs-phonk: Showing celebration');
			const imagePath = getRandomAsset('faces');
			const soundPath = getRandomAsset('phonk');
			
			console.log('vs-phonk: Image path:', imagePath);
			console.log('vs-phonk: Sound path:', soundPath);
			
			if (imagePath) {
				sidebarWebview.webview.options = {
					enableScripts: true,
					localResourceRoots: [context.extensionUri]
				};

				const imageUri = sidebarWebview.webview.asWebviewUri(vscode.Uri.file(imagePath));
				
				sidebarWebview.webview.html = `
					<!DOCTYPE html>
					<html>
					<head>
						<style>
							body {
								display: flex;
								justify-content: center;
								align-items: center;
								height: 100vh;
								margin: 0;
								background: #000000;
							}
							img {
								max-width: 100%;
								max-height: 100%;
							}
						</style>
					</head>
					<body>
						<img src="${imageUri}" alt="Jumpscare" />
					</body>
					</html>
				`;

				if (soundPath && !isAudioPlaying) {
					isAudioPlaying = true;
					const audioDuration = await getAudioDuration(soundPath);
					playSystemAudio(soundPath);
					
					setTimeout(() => {
						isAudioPlaying = false;
						updateSidebar(false);
					}, audioDuration);
				} else if (!soundPath) {
					setTimeout(() => {
						updateSidebar(false);
					}, TIMEOUT);
				}
			}
		} else {
			sidebarWebview.webview.html = `
				<!DOCTYPE html>
				<html>
				<head>
					<style>
						body {
							display: flex;
							justify-content: center;
							align-items: center;
							height: 100vh;
							margin: 0;
							background: black;
							color: white;
						}
					</style>
				</head>
				<body></body>
				</html>
			`;
		}
	};

	class SidebarProvider implements vscode.WebviewViewProvider {
		public static readonly viewType = 'vs-phonk.sidebar';

		resolveWebviewView(
			webviewView: vscode.WebviewView,
			_context: vscode.WebviewViewResolveContext,
			_token: vscode.CancellationToken
		) {
			sidebarWebview = webviewView;
			
			webviewView.webview.options = {
				enableScripts: true,
				localResourceRoots: [context.extensionUri]
			};

			updateSidebar(false);
		}
	}

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('vs-phonk.sidebar', new SidebarProvider())
	);

	const checkLinterErrors = () => {
		const diagnostics = vscode.languages.getDiagnostics();
		let currentErrorCount = 0;
		const currentFileErrors = new Map<string, number>();

		for (const [uri, diags] of diagnostics) {
			const errorCount = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
			if (errorCount > 0) {
				currentErrorCount += errorCount;
				currentFileErrors.set(uri.toString(), errorCount);
			}
		}

		if (linterState.errorCount > 0 && currentErrorCount < linterState.errorCount) {
			console.log('vs-phonk: Error count decreased from', linterState.errorCount, 'to', currentErrorCount);
			if (isAudioPlaying) {
				const imagePath = getRandomAsset('faces');
				if (imagePath && sidebarWebview) {
					const imageUri = sidebarWebview.webview.asWebviewUri(vscode.Uri.file(imagePath));
					sidebarWebview.webview.html = `
						<!DOCTYPE html>
						<html>
						<head>
							<style>
								body {
									display: flex;
									justify-content: center;
									align-items: center;
									height: 100vh;
									margin: 0;
									background: #000000;
								}
								img {
									max-width: 100%;
									max-height: 100%;
								}
							</style>
						</head>
						<body>
							<img src="${imageUri}" alt="Jumpscare" />
						</body>
						</html>
					`;
				}
			} else {
				updateSidebar(true);
			}
		}

		linterState.errorCount = currentErrorCount;
		linterState.fileErrors = currentFileErrors;
	};

	const disposable = vscode.workspace.onDidChangeTextDocument(() => {
		setTimeout(checkLinterErrors, 1000);
	});

	const diagnosticDisposable = vscode.languages.onDidChangeDiagnostics(() => {
		checkLinterErrors();
	});

	checkLinterErrors();

	const testCommand = vscode.commands.registerCommand('vs-phonk.makeMeFeelSigma', () => {
		updateSidebar(true);
	});

	context.subscriptions.push(disposable, diagnosticDisposable, testCommand);
}

export function deactivate() {}