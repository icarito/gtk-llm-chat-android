// Entrada de la app. El polyfill de getRandomValues DEBE evaluarse antes que
// cualquier módulo que cargue @noble (OMEMO 2): sin él, la cripto no tiene RNG.
import 'react-native-get-random-values';
import 'expo-router/entry';
