import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  allTasksCompletedMessage,
  expenseAddedMessage,
  expensesImportedMessage,
  purchaseAddedMessage,
  purchasesAddedMessage,
  purchasesImportedMessage,
  taskCompletedMessage,
  taskRestoredMessage,
} from "@/lib/success-messages";

describe("lib/success-messages.ts — exact wording and pluralisation", () => {
  it("taskCompletedMessage returns the exact required phrase", () => {
    expect(taskCompletedMessage()).toBe("Lovely jubbly — task completed");
  });

  it("taskRestoredMessage is neutral — no catchphrase", () => {
    expect(taskRestoredMessage()).toBe("Task restored");
  });

  it("allTasksCompletedMessage returns the exact title/body pair", () => {
    expect(allTasksCompletedMessage()).toEqual({ title: "He who dares — all tasks completed.", body: "No outstanding tasks today." });
  });

  it("purchaseAddedMessage (manual single add) never includes a count", () => {
    expect(purchaseAddedMessage()).toBe("Cushty — purchase added");
  });

  it("purchasesAddedMessage singular", () => {
    expect(purchasesAddedMessage(1)).toBe("Cushty — 1 purchase added");
  });

  it("purchasesAddedMessage plural", () => {
    expect(purchasesAddedMessage(11)).toBe("Cushty — 11 purchases added");
  });

  it("purchasesImportedMessage singular", () => {
    expect(purchasesImportedMessage(1)).toBe("Lovely jubbly — 1 purchase imported");
  });

  it("purchasesImportedMessage plural", () => {
    expect(purchasesImportedMessage(498)).toBe("Lovely jubbly — 498 purchases imported");
  });

  it("expenseAddedMessage returns the exact required phrase", () => {
    expect(expenseAddedMessage()).toBe("Sorted — expense added");
  });

  it("expensesImportedMessage singular", () => {
    expect(expensesImportedMessage(1)).toBe("Sorted — 1 expense imported");
  });

  it("expensesImportedMessage plural", () => {
    expect(expensesImportedMessage(25)).toBe("Sorted — 25 expenses imported");
  });

  it("expensesImportedMessage never reuses the purchase wording ('Lovely jubbly')", () => {
    expect(expensesImportedMessage(1)).not.toContain("Lovely jubbly");
  });
});

describe("app/tasks/page.tsx — structural checks (no React test harness in this project)", () => {
  const source = readFileSync("app/tasks/page.tsx", "utf8");

  it("the completion toast uses the shared helper, not a hardcoded string", () => {
    expect(source).toContain("taskCompletedMessage()");
    expect(source).not.toContain("Task completed\"");
  });

  it("Undo remains wired to the completion toast", () => {
    expect(source).toContain('actionLabel="Undo"');
    expect(source).toContain("undoComplete");
  });

  it("reversing a task (Undo or 'mark as not done') shows the neutral restored message, not a catchphrase", () => {
    expect(source).toContain("taskRestoredMessage()");
    const restoredLine = source.slice(source.indexOf('toast?.kind === "restored"'));
    expect(restoredLine).not.toMatch(/actionLabel/);
  });

  it("settle() only shows a toast via the caller-confirmed nextCompleted transition, never before it runs", () => {
    const settleFn = source.slice(source.indexOf("function settle("), source.indexOf("async function undoComplete"));
    expect(settleFn).toContain('setToast(nextCompleted ? { kind: "completed", task } : { kind: "restored" })');
  });

  it("the final-task celebratory empty state reuses the existing empty-state icon/layout, not a new element", () => {
    expect(source).toContain("justCompletedAllToday");
    expect(source).toContain("<CheckIcon />");
    // only one EmptyState renderer exists — celebratory copy is injected via the copy map, not a parallel component
    expect(source.match(/function EmptyState/g)).toHaveLength(1);
  });

  it("the neutral empty state text is preserved verbatim for when there were no tasks to begin with", () => {
    expect(source).toContain("You’re all caught up.");
    expect(source).toContain("No outstanding tasks today.");
  });

  it("justClearedToday resets on a full reload, so a refresh returns to the neutral state", () => {
    const loadFn = source.slice(source.indexOf("async function load("), source.indexOf("useEffect(() => { load(); }"));
    expect(loadFn).toContain("setJustClearedToday(false)");
  });

  it("no catchphrase wording appears in the error banner", () => {
    const errorLine = source.split("\n").find(line => line.includes("home-error"));
    expect(errorLine).toBeDefined();
    expect(errorLine).not.toMatch(/Lovely jubbly|Cushty|Sorted —|He who dares/);
  });
});

describe("components/TodaysTasksCard.tsx — structural checks", () => {
  const source = readFileSync("components/TodaysTasksCard.tsx", "utf8");

  it("uses the same shared success-message helpers as the Tasks page", () => {
    expect(source).toContain("taskCompletedMessage()");
    expect(source).toContain("taskRestoredMessage()");
    expect(source).toContain("allTasksCompletedMessage()");
  });

  it("the 'final task of the day' check uses the unsliced actionable-today count, not the 5-item display slice", () => {
    const settleFn = source.slice(source.indexOf("function settle("), source.indexOf("const emptyCopy"));
    expect(settleFn).toContain("isTaskActionableToday");
    expect(settleFn).not.toContain(".slice(0, 5)");
  });

  it("Undo remains available on the completion toast here too", () => {
    expect(source).toContain('actionLabel="Undo"');
  });
});

describe("app/purchases/page.tsx — manual purchase-added toast", () => {
  const source = readFileSync("app/purchases/page.tsx", "utf8");

  it("shows the toast only for a genuine create, not an edit", () => {
    expect(source).toContain("const wasCreate = editing === undefined;");
    expect(source).toContain("if (wasCreate) setAddedToast(true);");
  });

  it("uses the shared purchaseAddedMessage helper (no count — always a single record)", () => {
    expect(source).toContain("purchaseAddedMessage()");
  });

  it("does not touch destructive-action wording (Clear all / Delete confirmations)", () => {
    expect(source).toContain("Clear all purchases?");
    expect(source).toContain("permanently removed");
  });
});

describe("components/ExpenseForm.tsx — manual expense-added message", () => {
  const source = readFileSync("components/ExpenseForm.tsx", "utf8");

  it("create case uses the catchphrase, edit case stays neutral", () => {
    expect(source).toContain('setMessage(expense ? "Expense updated." : expenseAddedMessage());');
  });

  it("failure wording remains professional, with no catchphrase", () => {
    const failureLine = source.split("\n").find(line => line.includes("Could not save expense"));
    expect(failureLine).toBeDefined();
    expect(failureLine).not.toMatch(/Lovely jubbly|Cushty|Sorted —|He who dares/);
  });
});

describe("Spreadsheet import success wiring (purchases + expenses)", () => {
  const dialogSource = readFileSync("components/SpreadsheetImportDialog.tsx", "utf8");
  const purchaseWrapper = readFileSync("components/PurchaseImportDialog.tsx", "utf8");
  const expenseWrapper = readFileSync("components/ExpenseImportDialog.tsx", "utf8");

  it("SpreadsheetImportDialog only shows the themed heading after commit succeeds (the result state), never during preview", () => {
    const resultBlock = dialogSource.slice(dialogSource.indexOf("{result ? ("), dialogSource.indexOf(") : ("));
    expect(resultBlock).toContain("successHeading");
    // preview.rows/preview.invalidCount belong to the pre-commit preview branch, not the result branch
    expect(resultBlock).not.toContain("preview.invalidCount");
  });

  it("the plain fallback wording still exists for callers that don't opt in", () => {
    expect(dialogSource).toContain("imported.`");
  });

  it("PurchaseImportDialog wires the purchase-import catchphrase", () => {
    expect(purchaseWrapper).toContain("purchasesImportedMessage");
    expect(purchaseWrapper).toContain("successHeading={purchasesImportedMessage}");
  });

  it("ExpenseImportDialog wires the expense-import catchphrase (a different one from purchases)", () => {
    expect(expenseWrapper).toContain("expensesImportedMessage");
    expect(expenseWrapper).toContain("successHeading={expensesImportedMessage}");
  });

  it("row-level validation errors keep their existing professional wording untouched", () => {
    expect(dialogSource).toContain("need attention");
    expect(dialogSource).not.toMatch(/need attention[\s\S]{0,80}(Lovely jubbly|Cushty|Sorted —)/);
  });
});

describe("app/vinted-import/page.tsx — accepted-candidates catchphrase", () => {
  const source = readFileSync("app/vinted-import/page.tsx", "utf8");

  it("uses purchasesAddedMessage, counting only body.inserted (genuinely saved records)", () => {
    expect(source).toContain("purchasesAddedMessage(body.inserted)");
  });

  it("falls back to plain wording when nothing was actually saved (e.g. an all-duplicates batch)", () => {
    const importFn = source.slice(source.indexOf("async function importSelected"), source.indexOf("function OrderGroup"));
    expect(importFn).toContain("body.inserted > 0 ? purchasesAddedMessage(body.inserted) : `Imported ${body.inserted}`");
  });

  it("reject/restore/delete confirmations remain neutral — no catchphrase leaks into unrelated actions", () => {
    expect(source).toContain("Candidate rejected. It can be restored from the rejected view.");
    expect(source).toContain("Candidate restored to pending review.");
    expect(source).toContain("Candidate permanently deleted.");
    for (const phrase of ["Candidate rejected", "Candidate restored to pending review", "Candidate permanently deleted", "Import failed", "Sync failed"]) {
      const line = source.split("\n").find(l => l.includes(phrase));
      if (line) expect(line).not.toMatch(/Lovely jubbly|Cushty|Sorted —|He who dares/);
    }
  });

  it("the sync-diagnostics message (AI extraction failures) stays professional", () => {
    expect(source).toContain("AI extraction unavailable");
    const diagnosticsBlock = source.slice(source.indexOf("const diagnosticLabels"), source.indexOf("const diagnosticLabels") + 500);
    expect(diagnosticsBlock).not.toMatch(/Lovely jubbly|Cushty|Sorted —|He who dares/);
  });
});

describe("No catchphrase leaks into forbidden locations across all touched files", () => {
  const files = [
    "app/tasks/page.tsx",
    "components/TodaysTasksCard.tsx",
    "app/purchases/page.tsx",
    "components/ExpenseForm.tsx",
    "components/SpreadsheetImportDialog.tsx",
    "components/PurchaseImportDialog.tsx",
    "components/ExpenseImportDialog.tsx",
    "app/vinted-import/page.tsx",
  ];

  for (const file of files) {
    it(`${file}: no catchphrase appears inside a role="alert" (validation/error) block`, () => {
      const source = readFileSync(file, "utf8");
      const alertBlocks = source.match(/role="alert"[^}]{0,200}/g) || [];
      for (const block of alertBlocks) expect(block).not.toMatch(/Lovely jubbly|Cushty|Sorted —|He who dares/);
    });
  }
});
