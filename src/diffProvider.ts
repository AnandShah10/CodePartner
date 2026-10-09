/**
 * Virtual document providers for preview/diff.
 */
import * as vscode from "vscode";

export class SingleContentProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange: vscode.Event<vscode.Uri> = this._onDidChange.event;

  constructor(private content: string) { }

  provideTextDocumentContent(
    _uri: vscode.Uri,
    _token: vscode.CancellationToken
  ): string {
    return this.content;
  }
}

export class CodePartnerDiffProvider implements vscode.TextDocumentContentProvider {
  public static scheme = "codepartner-diff";
  private _content = "";
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  provideTextDocumentContent(_uri: vscode.Uri): string {
    return this._content;
  }

  update(content: string) {
    this._content = content;
    this._onDidChange.fire(
      vscode.Uri.parse(`${CodePartnerDiffProvider.scheme}:Proposed_Change`)
    );
  }
}
