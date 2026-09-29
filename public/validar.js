// Reglas de validación compartidas: las usa el formulario (navegador) y la API (servidor),
// así los dos lados aceptan y rechazan exactamente lo mismo.
// Cada regla devuelve { valor, error }: `valor` es el dato limpio y `error` es null si está todo bien.
(function (global, crear) {
  const reglas = crear();
  if (typeof module === 'object' && module.exports) module.exports = reglas;
  else global.Validar = reglas;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const ok = (valor) => ({ valor, error: null });
  const mal = (valor, error) => ({ valor, error });

  // Saca tildes y pasa a minúsculas (para comparar y buscar).
  const plano = (texto) => String(texto ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

  function nombre(entrada) {
    const valor = String(entrada ?? '').trim().replace(/\s+/g, ' ');
    if (!valor) return mal(valor, 'Falta tu nombre y apellido.');
    if (valor.length > 80) return mal(valor, 'Es demasiado largo (máximo 80 caracteres).');
    if (!/^\p{L}[\p{L}'’. -]*$/u.test(valor)) return mal(valor, 'Usá solo letras, sin números ni símbolos.');
    const palabras = valor.split(' ').filter((p) => /\p{L}{2,}/u.test(p));
    if (palabras.length < 2) return mal(valor, 'Poné nombre y apellido.');
    return ok(valor);
  }

  function instagram(entrada) {
    let valor = String(entrada ?? '').trim();
    const deLink = valor.match(/instagram\.com\/([^/?#\s]+)/i);
    if (deLink) valor = deLink[1];
    valor = valor.replace(/^@+/, '').toLowerCase();
    if (!valor) return mal(valor, 'Falta tu usuario de Instagram.');
    if (!/^[a-z0-9._]{1,30}$/.test(valor)) {
      return mal(valor, 'Solo letras, números, puntos y guiones bajos (hasta 30), sin espacios.');
    }
    if (valor.startsWith('.') || valor.endsWith('.') || valor.includes('..')) {
      return mal(valor, 'Ese usuario no es válido en Instagram.');
    }
    return ok(valor);
  }

  // Edad cumplida en una fecha de referencia ("AAAA-MM-DD..."), sin problemas de zona horaria.
  function edad(nacimiento, referencia) {
    const [ny, nm, nd] = String(nacimiento).slice(0, 10).split('-').map(Number);
    const [ry, rm, rd] = String(referencia).slice(0, 10).split('-').map(Number);
    return ry - ny - (rm < nm || (rm === nm && rd < nd) ? 1 : 0);
  }

  function hoy() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function cumpleanos(entrada, { edadMinima = 0, referencia } = {}) {
    const valor = String(entrada ?? '').trim();
    const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor);
    if (!partes) return mal(valor, 'Falta tu fecha de cumpleaños.');
    const [a, m, d] = partes.slice(1).map(Number);
    const fecha = new Date(Date.UTC(a, m - 1, d));
    if (fecha.getUTCFullYear() !== a || fecha.getUTCMonth() !== m - 1 || fecha.getUTCDate() !== d) {
      return mal(valor, 'Esa fecha no existe.');
    }
    if (a < 1900 || valor > hoy()) return mal(valor, 'Revisá el año de nacimiento.');
    if (edadMinima && edad(valor, referencia || hoy()) < edadMinima) {
      return mal(valor, `Tenés que tener ${edadMinima} años o más${referencia ? ' el día de la fiesta' : ''}.`);
    }
    return ok(valor);
  }

  // Teléfono con código de país. Los de Argentina se guardan como +549 + área + número,
  // el formato que usa WhatsApp.
  function telefono(entrada) {
    const valor = String(entrada ?? '').trim().replace(/[\s().-]/g, '');
    if (!valor || valor === '+' || valor === '+54' || valor === '+549') return mal(valor, 'Falta tu número de teléfono.');
    if (!valor.startsWith('+')) return mal(valor, 'Empezá con + y el código de país (ej. +54).');
    if (!/^\+\d+$/.test(valor)) return mal(valor, 'Usá solo números después del +.');
    if (valor.startsWith('+54')) {
      let nacional = valor.slice(3);
      if (nacional.startsWith('9')) nacional = nacional.slice(1);
      if (nacional.startsWith('0')) return mal(valor, 'Sacá el 0 del código de área (ej. +54 9 11 1234 5678).');
      if (nacional.length !== 10) {
        return mal(valor, 'Poné código de área y número, sin 0 ni 15 (ej. +54 9 11 1234 5678).');
      }
      return ok(`+549${nacional}`);
    }
    if (!/^\+[1-9]\d{7,14}$/.test(valor)) return mal(valor, 'Revisá el número: código de país y número completo.');
    return ok(valor);
  }

  function consentimiento(entrada) {
    return entrada === true ? ok(true) : mal(false, 'Para registrarte tenés que aceptar el uso de tus datos.');
  }

  // Valida todo el formulario de registro. Devuelve los valores limpios o un error por campo.
  function registro(datos, opciones = {}) {
    const resultados = {
      nombre: nombre(datos?.nombre),
      instagram: instagram(datos?.instagram),
      cumpleanos: cumpleanos(datos?.cumpleanos, opciones),
      telefono: telefono(datos?.telefono),
      consentimiento: consentimiento(datos?.consentimiento),
    };
    const valores = {};
    const errores = {};
    for (const [campo, { valor, error }] of Object.entries(resultados)) {
      valores[campo] = valor;
      if (error) errores[campo] = error;
    }
    return { valores, errores: Object.keys(errores).length ? errores : null };
  }

  // Códigos de RRPP: sin espacios ni tildes y en mayúsculas ("caña 2" = "CANA2").
  function codigo(entrada) {
    return plano(entrada).toUpperCase().replace(/\s+/g, '');
  }

  // Pesos enteros. Acepta "15000", "15.000" o "$ 15.000"; devuelve NaN si no es un monto válido.
  function pesos(entrada) {
    if (typeof entrada === 'number') return Number.isInteger(entrada) && entrada >= 0 ? entrada : NaN;
    const texto = String(entrada ?? '').replace(/[$\s]/g, '');
    if (/^\d+$/.test(texto)) return Number(texto);
    if (/^\d{1,3}(\.\d{3})+$/.test(texto)) return Number(texto.replace(/\./g, ''));
    return NaN;
  }

  return { nombre, instagram, cumpleanos, telefono, consentimiento, registro, edad, codigo, pesos, plano };
}));
