use crate::Project;
use wasm_bindgen::prelude::*;

fn js_error(error: impl std::fmt::Display) -> JsValue {
    // A string keeps this wrapper independent of browser-specific globals.
    JsValue::from_str(&error.to_string())
}

/// This is a thin boundary: every rule lives in Project, shared with the server.
#[wasm_bindgen(js_name = ProjectState)]
pub struct WasmProject(Project);

#[wasm_bindgen(js_class = ProjectState)]
impl WasmProject {
    #[wasm_bindgen(constructor)]
    pub fn new(name: &str) -> std::result::Result<WasmProject, JsValue> {
        Project::new(name).map(Self).map_err(js_error)
    }

    #[wasm_bindgen(js_name = fromSnapshot)]
    pub fn from_snapshot(bytes: &[u8]) -> std::result::Result<WasmProject, JsValue> {
        Project::from_snapshot(bytes).map(Self).map_err(js_error)
    }

    pub fn dispatch(&mut self, command: &str) -> std::result::Result<String, JsValue> {
        let result = self.0.apply_json(command).map_err(js_error)?;
        serde_json::to_string(&result).map_err(js_error)
    }

    pub fn view(&self) -> std::result::Result<String, JsValue> {
        serde_json::to_string(&self.0.view().map_err(js_error)?).map_err(js_error)
    }

    pub fn snapshot(&self) -> std::result::Result<Vec<u8>, JsValue> {
        self.0.snapshot().map_err(js_error)
    }

    pub fn merge(&mut self, bytes: &[u8]) -> std::result::Result<(), JsValue> {
        self.0.merge(bytes).map_err(js_error)
    }

    pub fn version(&self) -> Vec<u8> {
        self.0.version()
    }
    #[wasm_bindgen(js_name = startGroup)]
    pub fn start_group(&mut self) -> std::result::Result<(), JsValue> {
        self.0.start_group().map_err(js_error)
    }
    #[wasm_bindgen(js_name = stopGroup)]
    pub fn stop_group(&mut self) {
        self.0.stop_group();
    }
    #[wasm_bindgen(js_name = clearHistory)]
    pub fn clear_history(&mut self) {
        self.0.clear_history();
    }
    #[wasm_bindgen(js_name = undoCount)]
    pub fn undo_count(&self) -> usize {
        self.0.undo_count()
    }
    #[wasm_bindgen(js_name = redoCount)]
    pub fn redo_count(&self) -> usize {
        self.0.redo_count()
    }
    pub fn cursor(
        &self,
        id: &str,
        index: usize,
        after: bool,
    ) -> std::result::Result<Vec<u8>, JsValue> {
        self.0.cursor(id, index, after).map_err(js_error)
    }
    #[wasm_bindgen(js_name = resolveCursor)]
    pub fn resolve_cursor(&self, id: &str, bytes: &[u8]) -> std::result::Result<usize, JsValue> {
        self.0.resolve_cursor(id, bytes).map_err(js_error)
    }
    #[wasm_bindgen(js_name = editDraft)]
    pub fn edit_draft(
        &mut self,
        id: &str,
        base: &[u8],
        next: &str,
        caret: usize,
    ) -> std::result::Result<usize, JsValue> {
        self.0.edit_draft(id, base, next, caret).map_err(js_error)
    }

    #[wasm_bindgen(js_name = canUndo)]
    pub fn can_undo(&self) -> bool {
        self.0.can_undo()
    }
    #[wasm_bindgen(js_name = canRedo)]
    pub fn can_redo(&self) -> bool {
        self.0.can_redo()
    }
}
