/*
 * history.js
 * Undo / redo. Every change to the drawing is saved as a "step" that knows
 * how to undo itself and how to redo itself. Keeps the last 50 steps.
 */
(function () {
  'use strict';

  class UndoHistory {
    constructor(limit) {
      this.limit = limit || 50;
      this.undoStack = [];
      this.redoStack = [];
      this.onChange = null;
    }

    /** step = { label, undo(), redo(), frame? (the frame it changed) } */
    push(step) {
      this.undoStack.push(step);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
      this.redoStack.length = 0;
      this._changed();
    }

    undo() {
      const step = this.undoStack.pop();
      if (!step) return null;
      step.undo();
      this.redoStack.push(step);
      this._changed();
      return step;
    }

    redo() {
      const step = this.redoStack.pop();
      if (!step) return null;
      step.redo();
      this.undoStack.push(step);
      this._changed();
      return step;
    }

    get canUndo() { return this.undoStack.length > 0; }
    get canRedo() { return this.redoStack.length > 0; }

    _changed() { if (this.onChange) this.onChange(); }
  }

  window.UndoHistory = UndoHistory;
})();
