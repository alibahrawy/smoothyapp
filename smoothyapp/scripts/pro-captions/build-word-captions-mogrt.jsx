/*
 * Builds the Smoothy Pro word caption templates for Premiere Pro:
 *
 *   word-rise         "Smoothy Word Rise"   each word fades in from below into its place
 *   word-slide        "Smoothy Word Slide"  each word fades in from the right into its place
 *   stroke-highlight  "Smoothy Outline"     white text with a dark outline; the word being
 *                                           said turns Smoothy Lime (#92F388)
 *
 * Rise and Slide use Inter Display Bold (SIL OFL, the closest free match to
 * SF Pro Display, which cannot be bundled) with tight letter spacing.
 * Outline uses Inter Display ExtraBold. The fonts ship in smoothyapp-cep/fonts
 * and the app installs them before the first send.
 *
 * Run through `node scripts/pro-captions/build-mogrt.mjs --template <id>`
 * (macOS), which sets $.global.SMOOTHY_TEMPLATE_ID, or in After Effects via
 * File > Scripts > Run Script File after setting that global. Writes
 * smoothyapp-cep/mogrt/.build/<Template Name>.mogrt.
 *
 * Contract with smoothyapp-cep/jsx/host.jsx (keep the names in sync):
 *   "Caption Text", "Word Timings" ("start,end;…" seconds from the clip start),
 *   "Text Color", "Shadow Opacity", "Caption Size", "Vertical Position",
 *   and for Outline also "Highlight Color", "Stroke Color", "Stroke Width".
 * The comp is 3840x2160; host.jsx scales each clip to the sequence. Design
 * units are 1920x1080 px at Caption Size 100.
 */
(function buildWordCaptionsMogrt() {
  var TEMPLATES = {
    'word-rise': {
      name: 'Smoothy Word Rise', font: 'InterDisplay-Bold', fontSize: 70, tracking: -20,
      reveal: 'move', from: [0, 34], frames: 7
    },
    'word-slide': {
      name: 'Smoothy Word Slide', font: 'InterDisplay-Bold', fontSize: 70, tracking: -20,
      reveal: 'move', from: [46, 0], frames: 7
    },
    'stroke-highlight': {
      name: 'Smoothy Outline', font: 'InterDisplay-ExtraBold', fontSize: 72, tracking: -10,
      reveal: 'color'
    }
  };
  var id = $.global.SMOOTHY_TEMPLATE_ID;
  var T = TEMPLATES[id];
  var repoRoot = $.global.SMOOTHY_REPO_ROOT || new File($.fileName).parent.parent.parent.parent.fsName;
  var outFolder = new Folder(repoRoot + '/smoothyapp-cep/mogrt');
  if (!outFolder.exists) outFolder.create();
  var outPath = outFolder.fsName + '/.build';
  var statusFile = new File(outFolder.fsName + '/.build-status.txt');
  var BUILD_PROJECT = 'smoothy-caption-template-build.aep';

  function report(text) {
    try { statusFile.open('w'); statusFile.write(text); statusFile.close(); } catch (e) {}
  }

  var WHITE = [1, 1, 1, 1];
  var INK = [21 / 255, 21 / 255, 21 / 255, 1];
  var LIME = [146 / 255, 243 / 255, 136 / 255, 1];
  var BLACK = [0, 0, 0, 1];

  try {
    if (!T) throw new Error('Unknown template "' + id + '"');
    var current = app.project;
    if (current) {
      // Only discard a project that holds nothing but a previous template build.
      var onlyOurs = !current.file || current.file.name === BUILD_PROJECT || current.file.name === 'smoothy-box-highlight-build.aep';
      for (var n = 1; onlyOurs && n <= current.numItems; n++) {
        var item = current.item(n);
        var inSolids = item.parentFolder && item.parentFolder.name === 'Solids';
        if (item.name.indexOf('Smoothy ') !== 0 && item.name !== 'Solids' && !inSolids) onlyOurs = false;
      }
      if (!onlyOurs && current.numItems > 0) throw new Error('Save and close your After Effects project first.');
      current.close(CloseOptions.DO_NOT_SAVE_CHANGES);
    }
    app.beginSuppressDialogs();
    app.newProject();
    var comp = app.project.items.addComp(T.name, 3840, 2160, 1, 30, 30);

    // ---------------------------------------------------------------- controls
    var controls = comp.layers.addNull();
    controls.name = 'Controls';
    var effects = controls.property('ADBE Effect Parade');
    function addControl(match, name, value) {
      var effect = effects.addProperty(match);
      effect.name = name;
      effect.property(1).setValue(value);
    }
    var controlNames = [];
    function exposed(match, name, value) { addControl(match, name, value); controlNames.push(name); }
    var outline = T.reveal === 'color';
    exposed('ADBE Color Control', 'Text Color', WHITE);
    if (outline) {
      exposed('ADBE Color Control', 'Highlight Color', LIME);
      exposed('ADBE Color Control', 'Stroke Color', INK);
      exposed('ADBE Slider Control', 'Stroke Width', 9);
    }
    exposed('ADBE Slider Control', 'Shadow Opacity', outline ? 35 : 45);
    exposed('ADBE Slider Control', 'Caption Size', 100);
    exposed('ADBE Slider Control', 'Vertical Position', 85);
    var C = 'thisComp.layer("Controls").effect';

    // Rig null: size and position for everything.
    var rig = comp.layers.addNull();
    rig.name = 'Rig';
    var rigT = rig.property('ADBE Transform Group');
    rigT.property('ADBE Position').expression =
      '[thisComp.width / 2, thisComp.height * ' + C + '("Vertical Position")("Slider") / 100]';
    rigT.property('ADBE Scale').expression =
      'var s = ' + C + '("Caption Size")("Slider") * thisComp.width / 1920;\n[s, s]';

    // Hidden data layer: per-word timings.
    var timings = comp.layers.addText('0,0.5;0.5,1;1,1.5;1.5,2;2,2.5;2.5,3');
    timings.name = 'Word Timings';
    timings.property('ADBE Transform Group').property('ADBE Opacity').setValue(0);
    var timingsText = timings.property('ADBE Text Properties').property('ADBE Text Document');
    var timingsDoc = timingsText.value;
    timingsDoc.font = 'ArialMT';
    timingsDoc.fontSize = 20;
    timingsText.setValue(timingsDoc);

    // ---------------------------------------------------------------- caption
    var caption = comp.layers.addText('Every word moves into its place');
    caption.name = 'Caption';
    var sourceText = caption.property('ADBE Text Properties').property('ADBE Text Document');
    var doc = sourceText.value;
    doc.resetCharStyle();
    doc.resetParagraphStyle();
    doc.font = T.font;
    doc.fontSize = T.fontSize;
    doc.tracking = T.tracking;
    doc.fillColor = [WHITE[0], WHITE[1], WHITE[2]];
    doc.applyFill = true;
    if (outline) {
      doc.applyStroke = true;
      doc.strokeColor = [INK[0], INK[1], INK[2]];
      doc.strokeWidth = 9;
      doc.strokeOverFill = false; // fill over stroke: the outline never eats into the letters
    } else {
      doc.applyStroke = false;
    }
    doc.justification = ParagraphJustification.CENTER_JUSTIFY;
    sourceText.setValue(doc);
    if (sourceText.value.font !== T.font) throw new Error('Font ' + T.font + ' is not installed in After Effects (got ' + sourceText.value.font + ').');
    caption.setParentWithJump(rig);
    // The anchor is the baseline; lower the layer by half the cap height so the
    // line is centred on the Vertical Position.
    caption.property('ADBE Transform Group').property('ADBE Position').setValue([0, Math.round(T.fontSize * 0.364)]);

    var animators = caption.property('ADBE Text Properties').property('ADBE Text Animators');

    // Every animator below with a full-range selector applies to all characters.
    function fullAnimator(name) {
      var animator = animators.addProperty('ADBE Text Animator');
      animator.name = name;
      animator.property('ADBE Text Selectors').addProperty('ADBE Text Selector');
      return animator;
    }

    // Base colours (and outline) from the controls.
    var base = fullAnimator('Base');
    var baseProps = base.property('ADBE Text Animator Properties');
    baseProps.addProperty('ADBE Text Fill Color').expression = C + '("Text Color")("Color")';
    if (outline) {
      baseProps.addProperty('ADBE Text Stroke Color').expression = C + '("Stroke Color")("Color")';
      baseProps.addProperty('ADBE Text Stroke Width').expression = C + '("Stroke Width")("Slider")';
    }

    // Word start / end (seconds from the clip start) for textIndex, as expression source.
    var WORD = [
      'var raw = "" + thisComp.layer("Word Timings").text.sourceText.value;',
      'var parts = raw.split(";");',
      'var i = textIndex - 1;',
      'var pair = i < parts.length ? parts[i].split(",") : [];',
      'var ws = parseFloat(pair[0]), we = parseFloat(pair[1]);',
      'var f = timeToFrames(time - inPoint);'
    ].join('\n');

    if (!outline) {
      // Words not spoken yet are invisible and offset; each word eases into its
      // place over a few frames from its start (ease-out quart, no overshoot).
      var reveal = animators.addProperty('ADBE Text Animator');
      reveal.name = 'Reveal';
      var revealProps = reveal.property('ADBE Text Animator Properties');
      revealProps.addProperty('ADBE Text Position 3D').setValue([T.from[0], T.from[1], 0]);
      revealProps.addProperty('ADBE Text Opacity').setValue(0);
      var revealSelector = reveal.property('ADBE Text Selectors').addProperty('ADBE Text Expressible Selector');
      revealSelector.property('ADBE Text Range Type2').setValue(3); // Based on: Words
      revealSelector.property('ADBE Text Expressible Amount').expression = WORD + '\n' + [
        'var shown = 1;',
        'if (!isNaN(ws)) {',
        '  var u = Math.max(0, Math.min(1, (f - timeToFrames(ws)) / ' + T.frames + '));',
        '  shown = 1 - Math.pow(1 - u, 4);',
        '}',
        'var a = 100 * (1 - shown);',
        '[a, a, a]'
      ].join('\n');
    } else {
      // The word being said takes the Highlight Color.
      var highlight = animators.addProperty('ADBE Text Animator');
      highlight.name = 'Highlight';
      highlight.property('ADBE Text Animator Properties').addProperty('ADBE Text Fill Color')
        .expression = C + '("Highlight Color")("Color")';
      var hlSelector = highlight.property('ADBE Text Selectors').addProperty('ADBE Text Expressible Selector');
      hlSelector.property('ADBE Text Range Type2').setValue(3); // Based on: Words
      hlSelector.property('ADBE Text Expressible Amount').expression = WORD + '\n' + [
        'var on = !isNaN(ws) && !isNaN(we) && f >= timeToFrames(ws) - 0.001 && f < timeToFrames(we) - 0.001;',
        'var a = on ? 100 : 0;',
        '[a, a, a]'
      ].join('\n');
    }

    // Soft drop shadow for legibility on any footage. Effects on text render in
    // comp pixels, so distances follow the rig scale.
    var shadow = caption.property('ADBE Effect Parade').addProperty('ADBE Drop Shadow');
    shadow.property('ADBE Drop Shadow-0001').setValue([0, 0, 0, 1]);
    shadow.property('ADBE Drop Shadow-0002').expression = C + '("Shadow Opacity")("Slider") * 2.55';
    shadow.property('ADBE Drop Shadow-0003').setValue(180);
    var RS = 'thisComp.layer("Rig").transform.scale[0] / 100';
    shadow.property('ADBE Drop Shadow-0004').expression = '3 * ' + RS;
    shadow.property('ADBE Drop Shadow-0005').expression = (outline ? '6' : '10') + ' * ' + RS;

    // ---------------------------------------------------------------- Essential Graphics
    comp.motionGraphicsTemplateName = T.name;
    sourceText.addToMotionGraphicsTemplateAs(comp, 'Caption Text');
    timingsText.addToMotionGraphicsTemplateAs(comp, 'Word Timings');
    for (var c = 0; c < controlNames.length; c++) {
      comp.layer('Controls').property('ADBE Effect Parade').property(controlNames[c]).property(1)
        .addToMotionGraphicsTemplateAs(comp, controlNames[c]);
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
    app.project.save(new File(Folder.temp.fsName + '/' + BUILD_PROJECT));
    comp.openInViewer();
    var ok = comp.exportAsMotionGraphicsTemplate(true, outPath);
    app.endSuppressDialogs(false);
    report(ok ? 'OK ' + outPath : 'EXPORT_FAILED ' + outPath + ' (controllers: ' + comp.motionGraphicsTemplateControllerCount + ')');
  } catch (error) {
    try { app.endSuppressDialogs(false); } catch (ignored) {}
    report('ERROR line ' + error.line + ': ' + error.toString());
  }
})();
