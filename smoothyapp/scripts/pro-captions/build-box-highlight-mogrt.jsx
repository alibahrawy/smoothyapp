/*
 * Builds the Smoothy Pro "Box Highlight" caption template for Premiere Pro.
 *
 * The look: one line of Plus Jakarta Sans ExtraBold on a rounded colour box,
 * bottom centre. Words not spoken yet are dimmed and light up (with a crisp
 * drop shadow) as they are spoken; the box pops in after a pause. Source of
 * truth: docs/caption-pro/box-highlight (STYLE-SPEC.md, presets/box-highlight.json,
 * golden frames).
 *
 * Run through `node scripts/pro-captions/build-mogrt.mjs --template box-highlight`
 * (macOS), or in After Effects via File > Scripts > Run Script File. Writes
 * smoothyapp-cep/mogrt/.build/Smoothy Box Highlight.mogrt; build-mogrt.mjs
 * renames it to smoothy-box-highlight.mogrt and widens the slider ranges.
 *
 * Contract with smoothyapp-cep/jsx/host.jsx (keep the names in sync):
 *   "Caption Text"  – the line
 *   "Word Timings"  – "start,end;start,end;…" seconds from the clip start
 *   "Text Color", "Upcoming Word Opacity", "Box Color", "Box Opacity",
 *   "Box Radius", "Box Padding", "Box Height", "Shadow Opacity",
 *   "Caption Size", "Vertical Position", "Pop In"
 * The comp is 3840x2160 so text stays sharp in 4K; host.jsx scales each clip
 * to the sequence (50% in 1080p). Design units are 1920x1080 px at Caption Size
 * 100: the Rig null multiplies everything by thisComp.width / 1920.
 */
(function buildBoxHighlightMogrt() {
  var TEMPLATE_NAME = 'Smoothy Box Highlight';
  var FONT = 'PlusJakartaSans-ExtraBold';
  var FONT_SIZE = 65;
  var TRACKING = -30;            // thousandths of an em (-0.03em)
  var BASELINE = 18;             // baseline below the box centre at size 100 (font metrics, optical nudge included)
  var repoRoot = $.global.SMOOTHY_REPO_ROOT || new File($.fileName).parent.parent.parent.parent.fsName;
  var outFolder = new Folder(repoRoot + '/smoothyapp-cep/mogrt');
  if (!outFolder.exists) outFolder.create();
  var outPath = outFolder.fsName + '/.build';
  var statusFile = new File(outFolder.fsName + '/.build-status.txt');

  function report(text) {
    try { statusFile.open('w'); statusFile.write(text); statusFile.close(); } catch (e) {}
  }

  try {
    var current = app.project;
    if (current) {
      // Only discard a project that holds nothing but a previous build of this
      // template (its comp and the solids its nulls create).
      var buildFile = current.file && current.file.name === 'smoothy-box-highlight-build.aep';
      var onlyOurs = !current.file || buildFile;
      for (var n = 1; onlyOurs && n <= current.numItems; n++) {
        var item = current.item(n);
        var inSolids = item.parentFolder && item.parentFolder.name === 'Solids';
        if (item.name !== TEMPLATE_NAME && item.name !== 'Solids' && !inSolids) onlyOurs = false;
      }
      if (!onlyOurs && current.numItems > 0) throw new Error('Save and close your After Effects project first.');
      current.close(CloseOptions.DO_NOT_SAVE_CHANGES);
    }
    app.beginSuppressDialogs();
    app.newProject();
    var comp = app.project.items.addComp(TEMPLATE_NAME, 3840, 2160, 1, 30, 30);

    // ---------------------------------------------------------------- controls
    var controls = comp.layers.addNull();
    controls.name = 'Controls';
    var effects = controls.property('ADBE Effect Parade');
    function addControl(match, name, value) {
      var effect = effects.addProperty(match);
      effect.name = name;
      effect.property(1).setValue(value);
    }
    function control(name) {
      return comp.layer('Controls').property('ADBE Effect Parade').property(name).property(1);
    }
    // Smoothy brand: Lime box (#92F388) with Ink text (#151515), as on Smoothy's primary buttons.
    var LIME = [146 / 255, 243 / 255, 136 / 255, 1];
    var INK = [21 / 255, 21 / 255, 21 / 255, 1];
    addControl('ADBE Color Control', 'Text Color', INK);
    addControl('ADBE Slider Control', 'Upcoming Word Opacity', 42);
    addControl('ADBE Color Control', 'Box Color', LIME);
    addControl('ADBE Slider Control', 'Box Opacity', 100);
    addControl('ADBE Slider Control', 'Box Radius', 7);
    addControl('ADBE Slider Control', 'Box Padding', 20);   // from the letter edges (= 16 from the advance width in the reference renderer)
    addControl('ADBE Slider Control', 'Box Height', 95);
    addControl('ADBE Slider Control', 'Shadow Opacity', 0);
    addControl('ADBE Slider Control', 'Caption Size', 100);
    addControl('ADBE Slider Control', 'Vertical Position', 93.1);
    addControl('ADBE Checkbox Control', 'Pop In', 1);

    var C = 'thisComp.layer("Controls").effect';
    // Pop-in progress for the first frames of the clip: 0, .55, .85, 1 (no overshoot).
    var POP = [
      'var popOn = ' + C + '("Pop In")("Checkbox") > 0;',
      'var f = Math.floor(timeToFrames(time - inPoint) + 0.001);',
      'var steps = [0, 0.55, 0.85, 1];',
      'var k = (!popOn || f >= steps.length) ? 1 : steps[Math.max(0, f)];'
    ].join('\n');

    // Rig null: everything hangs off it, so size and pop scale around the box centre.
    var rig = comp.layers.addNull();
    rig.name = 'Rig';
    var rigT = rig.property('ADBE Transform Group');
    rigT.property('ADBE Position').expression =
      '[thisComp.width / 2, thisComp.height * ' + C + '("Vertical Position")("Slider") / 100]';
    rigT.property('ADBE Scale').expression = POP + '\n' +
      'var s = ' + C + '("Caption Size")("Slider") * (0.94 + 0.06 * k) * thisComp.width / 1920;\n[s, s]';

    // Hidden data layer: per-word timings.
    var timings = comp.layers.addText('0,0.5;0.5,1;1,1.5;1.5,2;2,2.5;2.5,3');
    timings.name = 'Word Timings';
    timings.property('ADBE Transform Group').property('ADBE Opacity').setValue(0);
    var timingsText = timings.property('ADBE Text Properties').property('ADBE Text Document');
    var timingsDoc = timingsText.value;
    timingsDoc.font = 'ArialMT';
    timingsDoc.fontSize = 20;
    timingsText.setValue(timingsDoc);

    // Lit amount per word (0 = not spoken, 1 = lit): 4-frame cubic ease-out from its start frame.
    function litSelector(selector) {
      selector.property('ADBE Text Range Type2').setValue(3); // Based on: Words
      selector.property('ADBE Text Expressible Amount').expression = [
        'var raw = "" + thisComp.layer("Word Timings").text.sourceText.value;',
        'var parts = raw.split(";");',
        'var i = textIndex - 1;',
        'var lit = 1;',
        'if (i < parts.length) {',
        '  var s = parseFloat(parts[i].split(",")[0]);',
        '  if (!isNaN(s)) {',
        '    var u = (timeToFrames(time - inPoint) - timeToFrames(s) + 1) / 4;',
        '    u = Math.max(0, Math.min(1, u));',
        '    lit = 1 - Math.pow(1 - u, 3);',
        '  }',
        '}',
        'var a = 100 * (1 - lit);',  // the animator applies to words NOT lit yet
        '[a, a, a]'
      ].join('\n');
    }

    function makeText(name) {
      var layer = comp.layers.addText('Box highlight captions light up word by word');
      layer.name = name;
      var sourceText = layer.property('ADBE Text Properties').property('ADBE Text Document');
      var doc = sourceText.value;
      doc.resetCharStyle();
      doc.resetParagraphStyle();
      doc.font = FONT;
      doc.fontSize = FONT_SIZE;
      doc.tracking = TRACKING;
      doc.fillColor = [INK[0], INK[1], INK[2]];
      doc.applyFill = true;
      doc.applyStroke = false;
      doc.justification = ParagraphJustification.CENTER_JUSTIFY;
      sourceText.setValue(doc);
      layer.setParentWithJump(rig);
      return layer;
    }

    // ---------------------------------------------------------------- caption text
    var caption = makeText('Caption');
    var capT = caption.property('ADBE Transform Group');
    capT.property('ADBE Position').setValue([0, BASELINE]);
    capT.property('ADBE Opacity').expression = POP + '\n100 * k';
    var capAnimators = caption.property('ADBE Text Properties').property('ADBE Text Animators');
    var color = capAnimators.addProperty('ADBE Text Animator');
    color.name = 'Text Color';
    color.property('ADBE Text Animator Properties').addProperty('ADBE Text Fill Color')
      .expression = C + '("Text Color")("Color")';
    color.property('ADBE Text Selectors').addProperty('ADBE Text Selector');
    var dim = capAnimators.addProperty('ADBE Text Animator');
    dim.name = 'Upcoming';
    dim.property('ADBE Text Animator Properties').addProperty('ADBE Text Opacity')
      .expression = C + '("Upcoming Word Opacity")("Slider")';
    litSelector(dim.property('ADBE Text Selectors').addProperty('ADBE Text Expressible Selector'));

    // ---------------------------------------------------------------- shadow (spoken words only)
    // A copy of the caption in black, offset (2.5, 3), slightly blurred. Its text
    // follows the caption; upcoming words are fully transparent on it.
    var shadow = makeText('Shadow');
    shadow.moveAfter(caption);
    var shText = shadow.property('ADBE Text Properties').property('ADBE Text Document');
    shText.expression = 'var src = thisComp.layer("Caption").text.sourceText;\n' +
      'src.style.setFillColor([0, 0, 0]).setText(src.value)';
    var shT = shadow.property('ADBE Transform Group');
    shT.property('ADBE Position').setValue([2.5, BASELINE + 3]);
    shT.property('ADBE Opacity').expression = POP + '\n' + C + '("Shadow Opacity")("Slider") * k';
    var shAnimators = shadow.property('ADBE Text Properties').property('ADBE Text Animators');
    var hide = shAnimators.addProperty('ADBE Text Animator');
    hide.name = 'Upcoming';
    hide.property('ADBE Text Animator Properties').addProperty('ADBE Text Opacity').setValue(0);
    litSelector(hide.property('ADBE Text Selectors').addProperty('ADBE Text Expressible Selector'));
    var blur = shadow.property('ADBE Effect Parade').addProperty('ADBE Gaussian Blur 2');
    blur.property(1).expression = 'thisComp.width / 1920';   // 1 px at 1080p

    // ---------------------------------------------------------------- box
    var box = comp.layers.addShape();
    box.name = 'Box';
    box.moveToEnd();
    box.setParentWithJump(rig);
    box.property('ADBE Transform Group').property('ADBE Position').setValue([0, 0]);
    box.property('ADBE Transform Group').property('ADBE Anchor Point').setValue([0, 0]);
    var contents = box.property('ADBE Root Vectors Group');
    var group = contents.addProperty('ADBE Vector Group');
    group.name = 'Box';
    var vectors = group.property('ADBE Vectors Group');
    var rect = vectors.addProperty('ADBE Vector Shape - Rect');
    // Width hugs the caption's ink; the caption is centred, so the box stays centred.
    rect.property('ADBE Vector Rect Size').expression = [
      'var cap = thisComp.layer("Caption");',
      'var r = cap.sourceRectAtTime(time, false);',
      'var pad = ' + C + '("Box Padding")("Slider");',
      'var h = ' + C + '("Box Height")("Slider");',
      '[Math.max(0, r.width) + 2 * pad, h]'
    ].join('\n');
    rect.property('ADBE Vector Rect Position').expression = [
      'var cap = thisComp.layer("Caption");',
      'var r = cap.sourceRectAtTime(time, false);',
      '[cap.transform.position[0] + r.left + r.width / 2, 0]'
    ].join('\n');
    rect.property('ADBE Vector Rect Roundness').expression = C + '("Box Radius")("Slider")';
    var fill = vectors.addProperty('ADBE Vector Graphic - Fill');
    fill.property('ADBE Vector Fill Color').expression = C + '("Box Color")("Color")';
    fill.property('ADBE Vector Fill Opacity').expression = C + '("Box Opacity")("Slider")';
    box.property('ADBE Transform Group').property('ADBE Opacity').expression = POP + '\n100 * k';

    // ---------------------------------------------------------------- Essential Graphics
    comp.motionGraphicsTemplateName = TEMPLATE_NAME;
    comp.layer('Caption').property('ADBE Text Properties').property('ADBE Text Document')
      .addToMotionGraphicsTemplateAs(comp, 'Caption Text');
    comp.layer('Word Timings').property('ADBE Text Properties').property('ADBE Text Document')
      .addToMotionGraphicsTemplateAs(comp, 'Word Timings');
    var controlNames = ['Text Color', 'Upcoming Word Opacity', 'Box Color', 'Box Opacity', 'Box Radius', 'Box Padding',
      'Box Height', 'Shadow Opacity', 'Caption Size', 'Vertical Position', 'Pop In'];
    for (var c = 0; c < controlNames.length; c++) {
      control(controlNames[c]).addToMotionGraphicsTemplateAs(comp, controlNames[c]);
    }

    var outFolderBuild = new Folder(outPath);
    if (!outFolderBuild.exists) outFolderBuild.create();
    // Surface expression errors: a broken expression would ship a broken template.
    var broken = [];
    function scan(group, path) {
      for (var p = 1; p <= group.numProperties; p++) {
        var prop = group.property(p);
        if (prop.propertyType === PropertyType.PROPERTY) {
          if (prop.canSetExpression && prop.expression && prop.expressionError) broken.push(path + '/' + prop.name + ': ' + prop.expressionError);
        } else {
          scan(prop, path + '/' + prop.name);
        }
      }
    }
    for (var l = 1; l <= comp.numLayers; l++) scan(comp.layer(l), comp.layer(l).name);
    if (broken.length) throw new Error('Expression errors: ' + broken.join(' | '));
    // Export needs a saved project; keep it in the temp folder, never in the user's folders.
    app.project.save(new File(Folder.temp.fsName + '/smoothy-box-highlight-build.aep'));
    comp.openInViewer();
    var ok = comp.exportAsMotionGraphicsTemplate(true, outPath);
    app.endSuppressDialogs(false);
    report(ok ? 'OK ' + outPath : 'EXPORT_FAILED ' + outPath + ' (controllers: ' + comp.motionGraphicsTemplateControllerCount + ')');
  } catch (error) {
    try { app.endSuppressDialogs(false); } catch (ignored) {}
    report('ERROR line ' + error.line + ': ' + error.toString());
  }
})();
